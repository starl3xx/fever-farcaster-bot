import type { NextApiRequest, NextApiResponse } from "next";
import {
  getTodaysFeverGames,
  getRecapMetadata,
  getFeverStandings,
  type FeverGame,
} from "../../../src/lib/wnba";
import type { BoxscorePlayer } from "../../../src/lib/formatter";
import { findRecapVideoId } from "../../../src/lib/youtube";
import { downloadYouTubeMp4 } from "../../../src/lib/yt-download";
import { uploadToFarcasterStream } from "../../../src/lib/video";
import { formatRecapCast } from "../../../src/lib/formatter";
import { postToChannel } from "../../../src/lib/neynar";
import {
  isGamePosted,
  markGamePosted,
  getGameTracking,
  incrementGameTracking,
} from "../../../src/lib/store";
import { FEVER_TEAM_TRICODE, MAX_RECAP_RETRIES } from "../../../src/lib/config";

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
    const finalGames = games.filter((g) => g.isFinal);
    const results: Record<string, string> = {};

    for (const game of finalGames) {
      const out = await processGame(game);
      results[`game_${game.gameId}`] = out;
    }

    return res.status(200).json({
      ok: true,
      gamesChecked: finalGames.length,
      totalFeverGamesToday: games.length,
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

async function processGame(game: FeverGame): Promise<string> {
  const { gameId } = game;

  if (await isGamePosted(gameId)) {
    return "already posted";
  }

  // Fetch box score for scores + full team names.
  const box = await fetchBoxscore(gameId);
  if (!box) {
    return "boxscore unavailable";
  }

  // Look up the official WNBA recap metadata on the game page.
  const recapMeta = await getRecapMetadata(gameId);
  if (!recapMeta) {
    const count = await getGameTracking(gameId);
    if (count < MAX_RECAP_RETRIES) {
      await incrementGameTracking(gameId);
      return `waiting for recap metadata (retry ${count + 1}/${MAX_RECAP_RETRIES})`;
    }
    return `gave up: no recap metadata after ${MAX_RECAP_RETRIES} retries`;
  }

  // Prefer the boxscore's authoritative gameTimeUTC; only fall back to the
  // metadata's gameDateISO if the boxscore didn't supply one.
  const gameDateISO = box.gameTimeUTC || recapMeta.gameDateISO;

  // Look up the corresponding YouTube video.
  const videoId = await findRecapVideoId({
    recapTitle: recapMeta.title,
    gameDateISO,
    homeTricode: box.home.teamTricode,
    awayTricode: box.away.teamTricode,
    homeName: fullTeamName(box.home),
    awayName: fullTeamName(box.away),
  });
  if (!videoId) {
    const count = await getGameTracking(gameId);
    if (count < MAX_RECAP_RETRIES) {
      await incrementGameTracking(gameId);
      return `waiting for YouTube recap (retry ${count + 1}/${MAX_RECAP_RETRIES})`;
    }
    return `gave up: no YouTube recap match after ${MAX_RECAP_RETRIES} retries`;
  }

  // Try to produce a native video embed. On any failure, retry up to MAX
  // attempts (shared counter), then fall back to posting a YouTube-URL embed
  // so users still get a cast (with the YT card unfurling natively).
  let playbackUrl: string | null = null;
  let videoFailureReason: string | null = null;

  const download = await downloadYouTubeMp4(videoId);
  if (!download) {
    videoFailureReason = `yt-dlp download failed for ${videoId}`;
  } else {
    playbackUrl = await uploadToFarcasterStream(download.buffer, gameId);
    if (!playbackUrl) {
      videoFailureReason = "farcaster stream upload failed";
    }
  }

  if (videoFailureReason) {
    const count = await getGameTracking(gameId);
    if (count < MAX_RECAP_RETRIES) {
      await incrementGameTracking(gameId);
      return `${videoFailureReason} (retry ${count + 1}/${MAX_RECAP_RETRIES})`;
    }
    console.warn(
      `[check-games] ${videoFailureReason} after ${MAX_RECAP_RETRIES} retries — falling back to YouTube embed`
    );
    // Fall through to the post step with playbackUrl still null.
  }

  const isHome = box.home.teamTricode === FEVER_TEAM_TRICODE;
  const feverPlayers = (isHome ? box.home.players : box.away.players) || [];

  // Fetch league standings for Fever's record/streak/conf-rank line.
  // Non-fatal: if it fails we still post without the standings section.
  const standings = await getFeverStandings().catch((err) => {
    console.error("[check-games] standings fetch threw:", err);
    return null;
  });

  const text = formatRecapCast({
    homeTricode: box.home.teamTricode,
    awayTricode: box.away.teamTricode,
    homeShortName: box.home.teamName,
    awayShortName: box.away.teamName,
    homeScore: box.home.score,
    awayScore: box.away.score,
    feverPlayers,
    standings,
  });

  const usingVideo = playbackUrl !== null;
  const embedUrl = playbackUrl ?? `https://youtube.com/watch?v=${videoId}`;

  const result = await postToChannel(text, {
    embeds: [{ url: embedUrl }],
    hasVideo: usingVideo,
    idem: `fever-game-${gameId}`,
  });

  if (result.hash) {
    await markGamePosted(gameId, result.hash);
    return usingVideo
      ? `posted (video): ${result.hash}`
      : `posted (yt-fallback): ${result.hash}`;
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
