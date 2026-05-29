import type { NextApiRequest, NextApiResponse } from "next";
import {
  getTodaysFeverGames,
  getRecapMetadata,
  getFeverStandings,
  findWnbaRecapMp4Url,
} from "../../../src/lib/wnba";
import type { BoxscorePlayer } from "../../../src/lib/formatter";
import { uploadMp4UrlToFarcasterStream } from "../../../src/lib/video";
import { formatRecapCast } from "../../../src/lib/formatter";
import { postToChannel } from "../../../src/lib/neynar";
import {
  isGamePosted,
  markGamePosted,
  getGameTracking,
  incrementGameTracking,
  addPendingGame,
  removePendingGame,
  listPendingGames,
  acquireGameLock,
  releaseGameLock,
  getFallbackPosted,
  markFallbackPosted,
} from "../../../src/lib/store";
import {
  FEVER_TEAM_TRICODE,
  MAX_RECAP_RETRIES,
  RECAP_UPGRADE_WINDOW_MS,
  WNBA_GAME_PAGE_URL,
} from "../../../src/lib/config";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface BoxscoreTeam {
  teamTricode: string;
  teamName: string;
  teamCity: string;
  score: number;
  players: BoxscorePlayer[];
}

async function fetchBoxscore(gameId: string): Promise<{
  home: BoxscoreTeam;
  away: BoxscoreTeam;
  gameTimeUTC: string | null;
} | null> {
  const url = `https://cdn.wnba.com/static/json/liveData/boxscore/boxscore_${gameId}.json`;
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`[boxscore] fetch failed: ${res.status}`);
    return null;
  }
  const data = await res.json();
  const game = data?.game;
  if (!game?.homeTeam || !game?.awayTeam) return null;

  const pickTeam = (t: any): BoxscoreTeam => ({
    teamTricode: String(t?.teamTricode || ""),
    teamName: String(t?.teamName || ""),
    teamCity: String(t?.teamCity || ""),
    score: Number(t?.score ?? 0),
    players: Array.isArray(t?.players) ? (t.players as BoxscorePlayer[]) : [],
  });

  return {
    home: pickTeam(game.homeTeam),
    away: pickTeam(game.awayTeam),
    gameTimeUTC: game?.gameTimeUTC ? String(game.gameTimeUTC) : null,
  };
}

function fullTeamName(t: BoxscoreTeam): string {
  if (t.teamCity && t.teamName) return `${t.teamCity} ${t.teamName}`;
  return t.teamName || t.teamCity || t.teamTricode;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!verifyAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const games = await getTodaysFeverGames();
    const todaysFinalIds = games.filter((g) => g.isFinal).map((g) => g.gameId);

    // Seed the pending set with any final Fever game we see on today's
    // scoreboard. After day rollover the scoreboard will no longer include
    // these gameIds, but the pending set keeps them in the retry rotation.
    for (const id of todaysFinalIds) {
      await addPendingGame(id);
    }

    const pendingIds = await listPendingGames();
    const gameIds = Array.from(new Set([...todaysFinalIds, ...pendingIds]));

    const results: Record<string, string> = {};
    for (const gameId of gameIds) {
      results[`game_${gameId}`] = await processGame(gameId);
    }

    return res.status(200).json({
      ok: true,
      gamesChecked: gameIds.length,
      totalFeverGamesToday: games.length,
      pendingCount: pendingIds.length,
      results,
    });
  } catch (err) {
    console.error("[check-games] Error:", err);
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
}

async function processGame(gameId: string): Promise<string> {
  if (await isGamePosted(gameId)) {
    // Belt-and-suspenders: a posted game shouldn't still be in the pending
    // set, but clean it up if so.
    await removePendingGame(gameId);
    return "already posted";
  }

  // Serialize per-game work. Cron fires every 5 min; the video pipeline
  // (encode + TUS upload + ready-poll + classifier wait) routinely takes
  // 6-10 min. Without this lock, concurrent invocations each ran the full
  // pipeline and each published a cast.
  const locked = await acquireGameLock(gameId);
  if (!locked) {
    return "skipped: another invocation holds the lock";
  }

  let result: string;
  try {
    result = await processGameLocked(gameId);
  } catch (err) {
    // Release on unexpected error so the next cron can retry promptly
    // instead of waiting out the full lock TTL.
    await releaseGameLock(gameId);
    throw err;
  }
  // Only release on a successful post. For non-success outcomes (waiting,
  // retry, failure) the TTL absorbs the wait so we don't hammer the same
  // game in a tight loop.
  if (result.startsWith("posted")) {
    await releaseGameLock(gameId);
  }
  return result;
}

async function processGameLocked(gameId: string): Promise<string> {
  // Fetch box score for scores + full team names.
  const box = await fetchBoxscore(gameId);
  if (!box) {
    return "boxscore unavailable";
  }

  // Has a provisional image fallback already been posted for this game? If so,
  // the game is NOT sealed (that's GAME_POSTED, set only on a native video) —
  // we keep polling to upgrade it to video. fallback carries the {hash,fid}
  // we reply under.
  const fallback = await getFallbackPosted(gameId);

  // True once we're past the window in which we'll keep chasing a late mp4.
  // Prefer the boxscore tip time; fall back to the recap metadata's date.
  const tipMs = box.gameTimeUTC ? new Date(box.gameTimeUTC).getTime() : NaN;
  const pastUpgradeDeadline = (iso: string | null): boolean => {
    const ms = Number.isFinite(tipMs)
      ? tipMs
      : iso
        ? new Date(iso).getTime()
        : NaN;
    return Number.isFinite(ms) && Date.now() - ms > RECAP_UPGRADE_WINDOW_MS;
  };

  // Look up the official WNBA recap metadata on the game page.
  const recapMeta = await getRecapMetadata(gameId);
  if (!recapMeta) {
    // A fallback is already live; a null here is almost certainly transient
    // (the game page persists). Keep waiting for the mp4 rather than abandon
    // the upgrade — but still honor the deadline so we can't pend forever.
    if (fallback) {
      if (pastUpgradeDeadline(null)) {
        await removePendingGame(gameId);
        return "gave up: no mp4 within upgrade window; image fallback stands";
      }
      return "recap metadata transiently missing; awaiting mp4 upgrade";
    }
    const count = await getGameTracking(gameId);
    if (count < MAX_RECAP_RETRIES) {
      await incrementGameTracking(gameId);
      return `waiting for recap metadata (retry ${count + 1}/${MAX_RECAP_RETRIES})`;
    }
    await removePendingGame(gameId);
    return `gave up: no recap metadata after ${MAX_RECAP_RETRIES} retries`;
  }

  // Prefer the boxscore's authoritative gameTimeUTC; only fall back to the
  // metadata's gameDateISO if the boxscore didn't supply one.
  const gameDateISO = box.gameTimeUTC || recapMeta.gameDateISO;

  // Source the clean 720p mp4 directly from the WNBA team-site CDN. The recap
  // is uploaded ~1-2 hours after final (and for some road games never at all),
  // so this 404s while we wait for the digital staff to publish it.
  let playbackUrl: string | null = null;
  let videoFailureReason: string | null = null;

  const mp4Url = await findWnbaRecapMp4Url(gameDateISO);
  if (!mp4Url) {
    videoFailureReason = "WNBA recap mp4 not yet posted";
  } else {
    playbackUrl = await uploadMp4UrlToFarcasterStream(mp4Url, gameId);
    if (!playbackUrl) {
      videoFailureReason = "farcaster stream upload failed";
    }
  }

  const isHome = box.home.teamTricode === FEVER_TEAM_TRICODE;
  const feverPlayers = (isHome ? box.home.players : box.away.players) || [];

  // Fetch league standings for Fever's record/streak/conf-rank line.
  // Non-fatal: if it fails we still post without the standings section.
  const standings = await getFeverStandings().catch((err) => {
    console.error("[check-games] standings fetch threw:", err);
    return null;
  });

  const baseRecap = {
    homeTricode: box.home.teamTricode,
    awayTricode: box.away.teamTricode,
    homeShortName: box.home.teamName,
    awayShortName: box.away.teamName,
    homeScore: box.home.score,
    awayScore: box.away.score,
    feverPlayers,
    standings,
  };

  // ---- CASE A: we have a native video ----
  if (playbackUrl) {
    const text = formatRecapCast(baseRecap);

    // If an image fallback already posted, thread the video under it as a reply
    // (an in-place "upgrade") instead of a duplicate top-level cast. The reply
    // parent is (author fid, hash); we capture the fid when posting the
    // fallback, with FARCASTER_FID as a backstop.
    const parentFid =
      fallback?.fid ??
      (process.env.FARCASTER_FID ? Number(process.env.FARCASTER_FID) : undefined);
    const parent =
      fallback && parentFid ? { fid: parentFid, hash: fallback.hash } : undefined;

    const result = await postToChannel(text, {
      embeds: [{ url: playbackUrl }],
      hasVideo: true,
      idem: `fever-game-${gameId}`,
      parent,
    });

    if (result.hash) {
      await markGamePosted(gameId, result.hash);
      await removePendingGame(gameId);
      if (!fallback) return `posted (video): ${result.hash}`;
      return parent
        ? `posted (video upgrade reply): ${result.hash}`
        : `posted (video upgrade, non-reply — no parent fid): ${result.hash}`;
    }
    return `post failed: ${result.error}`;
  }

  // ---- CASE B: no native video ----

  // B1: an image fallback is already live — never re-post it. Keep polling for
  // the mp4 to upgrade, or give up once past the deadline (the image stands).
  if (fallback) {
    if (pastUpgradeDeadline(gameDateISO)) {
      await removePendingGame(gameId);
      return "gave up: no mp4 within upgrade window; image fallback stands";
    }
    return `${videoFailureReason}; image fallback already posted, awaiting mp4 upgrade`;
  }

  // B2: no fallback yet — keep retrying for the mp4 through the initial window.
  const count = await getGameTracking(gameId);
  if (count < MAX_RECAP_RETRIES) {
    await incrementGameTracking(gameId);
    return `${videoFailureReason} (retry ${count + 1}/${MAX_RECAP_RETRIES})`;
  }

  // Initial window exhausted — post the image fallback: the recap's own
  // thumbnail as the embed (a direct image renders as a clean inline card; the
  // wnba.com/watch permalink does NOT — its head has no og:video and renders an
  // empty card) plus a "Watch recap" link in the body. Crucially we do NOT seal
  // the game (no markGamePosted / removePendingGame) so a later mp4 can upgrade.
  console.warn(
    `[check-games] ${videoFailureReason} after ${MAX_RECAP_RETRIES} retries — posting image fallback`
  );
  const text = formatRecapCast({
    ...baseRecap,
    recapWatchUrl: recapMeta.permalink || undefined,
  });
  const embedUrl = recapMeta.featuredImage || WNBA_GAME_PAGE_URL(gameId);

  const result = await postToChannel(text, {
    embeds: [{ url: embedUrl }],
    idem: `fever-game-${gameId}`,
  });

  if (result.hash) {
    await markFallbackPosted(gameId, { hash: result.hash, fid: result.fid });
    // Intentionally NOT markGamePosted / removePendingGame — keep the game
    // eligible so a later-arriving mp4 upgrades it to a native-video reply.
    return `posted (image fallback): ${result.hash} — awaiting mp4 upgrade`;
  }
  return `post failed: ${result.error}`;
}

function verifyAuth(req: NextApiRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  // Vercel cron sends this header automatically
  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${secret}`) return true;

  // Also check the x-cron-secret header (for manual testing)
  if (req.headers["x-cron-secret"] === secret) return true;

  return false;
}
