import {
  FEVER_TEAM_TRICODE,
  WNBA_SCOREBOARD_URL,
  WNBA_GAME_PAGE_URL,
} from "./config";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface FeverGame {
  gameId: string;
  homeTricode: string;
  awayTricode: string;
  gameStatus: number;
  gameStatusText: string;
  isFinal: boolean;
}

export interface RecapMetadata {
  id: string;
  title: string;
  permalink: string;
  videoDurationSeconds: number;
  featuredImage: string;
  franchiseName: string;
  gameDateISO: string;
}

/**
 * Parse a duration string like "02:02" or "1:23:45" into total seconds.
 */
function parseDurationToSeconds(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return 0;
  const parts = raw.split(":").map((p) => parseInt(p, 10));
  if (parts.some(Number.isNaN)) return 0;
  let seconds = 0;
  for (const p of parts) {
    seconds = seconds * 60 + p;
  }
  return seconds;
}

/**
 * Fetch the WNBA scoreboard for today and return all games involving the
 * Indiana Fever (IND), in either home or away slot.
 */
export async function getTodaysFeverGames(): Promise<FeverGame[]> {
  const res = await fetch(WNBA_SCOREBOARD_URL, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`WNBA scoreboard fetch failed: ${res.status}`);
  }

  const data = await res.json();
  const games: any[] = data?.scoreboard?.games || [];

  const feverGames: FeverGame[] = [];
  for (const game of games) {
    const homeTricode: string = game?.homeTeam?.teamTricode || "";
    const awayTricode: string = game?.awayTeam?.teamTricode || "";

    if (homeTricode !== FEVER_TEAM_TRICODE && awayTricode !== FEVER_TEAM_TRICODE) {
      continue;
    }

    const gameStatus: number = Number(game?.gameStatus ?? 0);
    const gameStatusText: string = game?.gameStatusText || "";

    // gameStatus === 3 means Final in NBA/WNBA APIs. Confirm via text just in case.
    const isFinal =
      gameStatus === 3 ||
      gameStatusText.toLowerCase().includes("final");

    feverGames.push({
      gameId: String(game?.gameId || ""),
      homeTricode,
      awayTricode,
      gameStatus,
      gameStatusText,
      isFinal,
    });
  }

  return feverGames;
}

/**
 * Fetch the WNBA game page and extract the official recap video metadata
 * from the embedded __NEXT_DATA__ JSON.
 *
 * Preference order:
 *   1. videoFranchisesName === "2-minute-game-recap" with entitlements === "free"
 *   2. videoFranchisesName === "quick-game" with entitlements === "free"
 *   3. null
 */
export async function getRecapMetadata(
  gameId: string
): Promise<RecapMetadata | null> {
  const res = await fetch(WNBA_GAME_PAGE_URL(gameId), {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    console.error(`[wnba] game page fetch failed: ${res.status}`);
    return null;
  }

  const html = await res.text();
  const match = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) {
    console.error("[wnba] No __NEXT_DATA__ script tag in game page");
    return null;
  }

  let payload: any;
  try {
    payload = JSON.parse(match[1]);
  } catch (err) {
    console.error("[wnba] Failed to parse __NEXT_DATA__ JSON:", err);
    return null;
  }

  const pageProps = payload?.props?.pageProps || {};
  const highlightVideos: any[] = pageProps?.highlightVideos || [];

  if (!highlightVideos.length) {
    return null;
  }

  // Try preferred franchise first, then fallback.
  const findByFranchise = (franchise: string) =>
    highlightVideos.find(
      (v) =>
        v?.videoFranchisesName === franchise && v?.entitlements === "free"
    );

  const pick = findByFranchise("2-minute-game-recap") || findByFranchise("quick-game");
  if (!pick) return null;

  const gameDateISO: string =
    pick?.gameDateISO ||
    pageProps?.game?.gameDateUTC ||
    pageProps?.game?.gameDateEst ||
    pageProps?.gameDate ||
    new Date().toISOString();

  return {
    id: String(pick?.id || ""),
    title: String(pick?.title || ""),
    permalink: String(pick?.permalink || ""),
    videoDurationSeconds: parseDurationToSeconds(
      pick?.videoDurationSeconds ?? pick?.videoDuration
    ),
    featuredImage: String(pick?.featuredImage || ""),
    franchiseName: String(pick?.videoFranchisesName || ""),
    gameDateISO,
  };
}
