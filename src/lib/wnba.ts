import type { BoxscorePlayer } from "./formatter";
import {
  FEVER_TEAM_TRICODE,
  ESPN_SCOREBOARD_URL,
  ESPN_SUMMARY_URL,
  WNBA_STANDINGS_URL,
} from "./config";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface FeverGame {
  gameId: string; // ESPN event id (e.g. "401856995")
  homeTricode: string;
  awayTricode: string;
  gameStatus: number;
  gameStatusText: string;
  isFinal: boolean;
}

export interface GameSummaryTeam {
  teamTricode: string; // e.g. "IND"
  teamName: string; // short name, e.g. "Fever"
  teamCity: string; // e.g. "Indiana"
  score: number;
  players: BoxscorePlayer[];
}

export interface GameSummary {
  home: GameSummaryTeam;
  away: GameSummaryTeam;
  gameTimeUTC: string | null;
  /** Recap thumbnail (a direct image URL) for the non-video image fallback. */
  recapThumbnail: string | null;
  /** ESPN gamecast URL, dropped in the fallback body as a "watch" link. */
  recapWatchUrl: string | null;
}

/**
 * Fetch JSON defensively. The dead WNBA endpoints returned a 200 with an HTML
 * body, so a naive res.json() threw a SyntaxError that 500'd the whole cron on
 * every tick. Here a non-OK status, a non-JSON body, or a parse error all
 * resolve to null and log — the caller degrades gracefully instead of crashing.
 */
async function fetchJsonSafe<T>(url: string, tag: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    });
    if (!res.ok) {
      console.error(`[${tag}] fetch failed: ${res.status}`);
      return null;
    }
    const ct = res.headers.get("content-type") || "";
    const body = await res.text();
    if (!ct.includes("json") && !body.trimStart().startsWith("{")) {
      console.error(
        `[${tag}] non-JSON response (content-type: ${ct || "none"}); first chars: ${body.slice(0, 40)}`
      );
      return null;
    }
    return JSON.parse(body) as T;
  } catch (err) {
    console.error(`[${tag}] fetch/parse error:`, err);
    return null;
  }
}

/**
 * ESPN's scoreboard buckets by calendar day, so a game that tips late and
 * finals after midnight can sit in "yesterday". We query yesterday + today (ET)
 * and dedup by event id so a just-finished game is never missed at the rollover.
 */
function espnDateWindow(): string[] {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .format(d)
      .replace(/-/g, "");
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return [fmt(now), fmt(yesterday)];
}

/**
 * Return all recent Fever games (yesterday + today, ET) from ESPN, in either
 * home or away slot. Returns [] on any upstream failure so the cron can still
 * fall through to its pending-game retries instead of erroring out.
 */
export async function getTodaysFeverGames(): Promise<FeverGame[]> {
  const games = new Map<string, FeverGame>();

  for (const date of espnDateWindow()) {
    const data = await fetchJsonSafe<any>(
      `${ESPN_SCOREBOARD_URL}?dates=${date}`,
      "scoreboard"
    );
    const events: any[] = data?.events || [];
    for (const e of events) {
      const comp = e?.competitions?.[0];
      const competitors: any[] = comp?.competitors || [];
      const home = competitors.find((c) => c?.homeAway === "home");
      const away = competitors.find((c) => c?.homeAway === "away");
      const homeTricode = String(home?.team?.abbreviation || "");
      const awayTricode = String(away?.team?.abbreviation || "");

      if (
        homeTricode !== FEVER_TEAM_TRICODE &&
        awayTricode !== FEVER_TEAM_TRICODE
      ) {
        continue;
      }

      const gameId = String(e?.id || "");
      if (!gameId) continue;

      const type = comp?.status?.type || e?.status?.type || {};
      const isFinal = type?.completed === true;

      games.set(gameId, {
        gameId,
        homeTricode,
        awayTricode,
        // 3 == Final, matching the old WNBA convention the rest of the code reads.
        gameStatus: isFinal ? 3 : Number(type?.id ?? 0),
        gameStatusText: String(type?.description || type?.shortDetail || ""),
        isFinal,
      });
    }
  }

  return Array.from(games.values());
}

/**
 * Map one ESPN boxscore athlete (a positional stats array keyed by `labels`)
 * onto the BoxscorePlayer shape the formatter consumes. ESPN exposes no
 * first/last name split, so displayName is split on the first space. A player
 * counts as ACTIVE only if they actually logged stats — ESPN's `active`/`reason`
 * fields are unreliable (e.g. a 32-minute starter can show active=false).
 */
function mapEspnAthlete(
  a: any,
  labelIdx: Record<string, number>
): BoxscorePlayer {
  const stats: string[] = Array.isArray(a?.stats) ? a.stats : [];
  const played = a?.didNotPlay !== true && stats.length > 0;

  const get = (label: string): string => {
    const i = labelIdx[label];
    return i === undefined ? "" : String(stats[i] ?? "");
  };
  const splitMadeAttempted = (v: string): { made: number; att: number } => {
    const [made, att] = v.split("-");
    return { made: parseInt(made, 10) || 0, att: parseInt(att, 10) || 0 };
  };

  const fg = splitMadeAttempted(get("FG"));
  const ft = splitMadeAttempted(get("FT"));

  const name = String(a?.athlete?.displayName || "").trim();
  const sp = name.indexOf(" ");
  const firstName = sp === -1 ? name : name.slice(0, sp);
  const familyName = sp === -1 ? "" : name.slice(sp + 1);

  return {
    status: played ? "ACTIVE" : "DNP",
    firstName,
    familyName,
    statistics: {
      points: get("PTS"),
      reboundsTotal: get("REB"),
      assists: get("AST"),
      steals: get("STL"),
      blocks: get("BLK"),
      fieldGoalsMade: fg.made,
      fieldGoalsAttempted: fg.att,
      freeThrowsMade: ft.made,
      freeThrowsAttempted: ft.att,
      turnovers: get("TO"),
    },
  };
}

/**
 * Fetch the ESPN game summary for an event id and project it into the scores,
 * team names, Fever boxscore, tip time, and a recap card (thumbnail + gamecast
 * link) the recap pipeline needs. One request supplies everything the old
 * boxscore + WNBA-game-page pair used to. Returns null on any upstream failure.
 */
export async function fetchGameSummary(
  eventId: string
): Promise<GameSummary | null> {
  const data = await fetchJsonSafe<any>(ESPN_SUMMARY_URL(eventId), "summary");
  if (!data) return null;

  const comp = data?.header?.competitions?.[0];
  const competitors: any[] = comp?.competitors || [];
  const homeC = competitors.find((c) => c?.homeAway === "home");
  const awayC = competitors.find((c) => c?.homeAway === "away");
  if (!homeC || !awayC) return null;

  const playerBlocks: any[] = data?.boxscore?.players || [];
  const playersFor = (abbr: string): BoxscorePlayer[] => {
    const block = playerBlocks.find((b) => b?.team?.abbreviation === abbr);
    const grp = block?.statistics?.[0];
    if (!grp) return [];
    const labels: string[] = grp.labels || grp.names || [];
    const labelIdx: Record<string, number> = {};
    labels.forEach((l, i) => {
      labelIdx[l] = i;
    });
    const athletes: any[] = grp.athletes || [];
    return athletes.map((a) => mapEspnAthlete(a, labelIdx));
  };

  const team = (c: any): GameSummaryTeam => {
    const t = c?.team || {};
    const tricode = String(t.abbreviation || "");
    return {
      teamTricode: tricode,
      teamName: String(t.name || ""),
      teamCity: String(t.location || ""),
      score: Number(c?.score ?? 0),
      players: playersFor(tricode),
    };
  };

  // Fallback card: prefer the recap article image, then the first highlight
  // thumbnail. Both are direct images that render as clean inline cards (unlike
  // the wnba.com/watch SPA, whose head has no og:video → empty card).
  const recapThumbnail =
    data?.article?.images?.[0]?.url || data?.videos?.[0]?.thumbnail || null;
  const recapWatchUrl =
    (data?.header?.links || []).find((l: any) =>
      (l?.rel || []).includes("summary")
    )?.href ||
    data?.article?.links?.web?.href ||
    null;

  return {
    home: team(homeC),
    away: team(awayC),
    gameTimeUTC: comp?.date ? String(comp.date) : null,
    recapThumbnail: recapThumbnail ? String(recapThumbnail) : null,
    recapWatchUrl: recapWatchUrl ? String(recapWatchUrl) : null,
  };
}

/**
 * Construct and verify the Fever team-site mp4 URL for a recap on this date.
 *
 * The WNBA's WordPress media CDN publishes a clean 720p H.264/AAC mp4 for
 * every Fever game at a deterministic path, served unauthenticated via
 * CloudFront. This is the equivalent of MLB's playback URLs for the Cubs
 * bot — no transcoding needed, just download and upload.
 *
 * Pattern (verified across 2025 and 2026 Fever home + away games):
 *   videos.nba.com/wordpress/uploads/media/sites/fever/{YYYY}/{MM}/
 *     highlights-{YYMMDD}_1280x720.mp4
 *
 * The date is the game's local Eastern Time date (matches what the digital
 * team enters on the WP site, regardless of where the game was played).
 *
 * The digital team uploads ~1-2 hours after final, so this returns null
 * during that window. Callers should retry via MAX_RECAP_RETRIES.
 */
export async function findWnbaRecapMp4Url(
  gameDateISO: string
): Promise<string | null> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(gameDateISO));

  const yyyy = parts.find((p) => p.type === "year")!.value;
  const mm = parts.find((p) => p.type === "month")!.value;
  const dd = parts.find((p) => p.type === "day")!.value;
  const yy = yyyy.slice(-2);

  const url = `https://videos.nba.com/wordpress/uploads/media/sites/fever/${yyyy}/${mm}/highlights-${yy}${mm}${dd}_1280x720.mp4`;

  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": BROWSER_UA },
    });
    if (res.ok) {
      console.log(`[wnba-recap] mp4 ready (${res.headers.get("content-length")} bytes): ${url}`);
      return url;
    }
    console.log(`[wnba-recap] mp4 not yet posted: ${res.status} (${url})`);
    return null;
  } catch (err) {
    console.error(`[wnba-recap] HEAD failed for ${url}:`, err);
    return null;
  }
}

export interface FeverStandings {
  record: string;          // e.g. "4-2"
  winPct: number;          // e.g. 0.667
  currentStreak: string;   // e.g. "W3"  (space stripped from "W 3")
  conferenceRank: number;  // 1-indexed rank within East
  conferenceLabel: string; // e.g. "E. Conference"
}

/**
 * Fetch the WNBA standings page and extract Indiana's record, win pct, current
 * streak, and rank within the Eastern Conference. Returns null if anything
 * fails — callers should treat the standings line as optional.
 */
export async function getFeverStandings(): Promise<FeverStandings | null> {
  const res = await fetch(WNBA_STANDINGS_URL, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) {
    console.error(`[standings] fetch failed: ${res.status}`);
    return null;
  }

  const html = await res.text();
  const match = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) {
    console.error("[standings] No __NEXT_DATA__ script tag");
    return null;
  }

  let payload: any;
  try {
    payload = JSON.parse(match[1]);
  } catch (err) {
    console.error("[standings] Failed to parse __NEXT_DATA__:", err);
    return null;
  }

  const rows: any[] = payload?.props?.pageProps?.standingsRowsData || [];
  const indRow = rows.find((r) => r?.TeamTricode === FEVER_TEAM_TRICODE);
  if (!indRow) {
    console.error("[standings] IND row not in standingsRowsData");
    return null;
  }

  const conference: string = String(indRow.Conference || "East");
  // PlayoffRank is league-wide (1..N), but sorting Conference-mates by it
  // yields the canonical conference rank.
  const inConf = rows
    .filter((r) => r?.Conference === conference)
    .sort((a, b) => Number(a.PlayoffRank) - Number(b.PlayoffRank));
  const conferenceRank =
    inConf.findIndex((r) => r?.TeamTricode === FEVER_TEAM_TRICODE) + 1;

  const conferenceLabel =
    conference === "East" ? "E. Conference" : conference === "West" ? "W. Conference" : `${conference} Conference`;

  return {
    record: String(indRow.Record || `${indRow.WINS}-${indRow.LOSSES}`),
    winPct: Number(indRow.WinPCT) || 0,
    currentStreak: String(indRow.strCurrentStreak || "").replace(/\s+/g, ""),
    conferenceRank,
    conferenceLabel,
  };
}
