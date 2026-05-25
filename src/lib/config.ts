export const FEVER_TEAM_TRICODE = "IND";
export const FEVER_TEAM_NAME = "Indiana Fever";
export const CHANNEL_ID = process.env.FARCASTER_CHANNEL_ID || "fever";
export const CAST_CHAR_LIMIT = 1024;
export const WNBA_LEAGUE_ID = 10;
export const WNBA_SCOREBOARD_URL = `https://cdn.wnba.com/static/json/liveData/scoreboard/todaysScoreboard_${WNBA_LEAGUE_ID}.json`;
export const WNBA_GAME_PAGE_URL = (gameId: string) => `https://www.wnba.com/game/${gameId}`;
export const WNBA_STANDINGS_URL = "https://www.wnba.com/standings";

// YouTube channels to search for official recaps (preferred order).
// Verified 2026-05-22 against youtube.com/@WNBA and youtube.com/@IndianaFever
// (canonical channel pages → externalId field).
export const YOUTUBE_OFFICIAL_CHANNELS = {
  WNBA_LEAGUE: "UCO9a_ryN_l7DIDS-VIt-zmw", // @WNBA
  INDIANA_FEVER: "UC2FefohmBAtGBvZ8QHiy30A", // @IndianaFever
};

// Redis key prefixes and TTLs
export const REDIS_KEYS = {
  GAME_POSTED: "fever:game:", // fever:game:{gameId} → cast hash
  GAME_TRACKING: "fever:track:", // fever:track:{gameId} → retry count
  GAME_LOCK: "fever:lock:", // fever:lock:{gameId} → serialization lock
  PENDING_GAMES: "fever:pending", // Set of gameIds being retried across days
} as const;

export const REDIS_TTL = {
  GAME_POSTED: 60 * 60 * 24 * 30, // 30 days
  GAME_TRACKING: 60 * 60 * 6, // 6 hours — must outlive MAX_RECAP_RETRIES
  // Lock TTL must exceed function maxDuration (600s) so a crashed invocation
  // can't leave the lock held indefinitely, but is short enough that real
  // failures recover within a couple cron intervals.
  GAME_LOCK: 700,
} as const;

// Recap retry: 24 retries × 5 min interval = 2 hours max wait. The WNBA's
// official YouTube channel typically publishes a recap within an hour or two
// of a game ending. After this window we fall back to a YouTube-URL embed.
export const MAX_RECAP_RETRIES = 24;
