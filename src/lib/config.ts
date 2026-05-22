export const FEVER_TEAM_TRICODE = "IND";
export const FEVER_TEAM_NAME = "Indiana Fever";
export const CHANNEL_ID = process.env.FARCASTER_CHANNEL_ID || "fever";
export const CAST_CHAR_LIMIT = 1024;
export const WNBA_LEAGUE_ID = 10;
export const WNBA_SCOREBOARD_URL = `https://cdn.wnba.com/static/json/liveData/scoreboard/todaysScoreboard_${WNBA_LEAGUE_ID}.json`;
export const WNBA_GAME_PAGE_URL = (gameId: string) => `https://www.wnba.com/game/${gameId}`;

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
} as const;

export const REDIS_TTL = {
  GAME_POSTED: 60 * 60 * 24 * 30, // 30 days
  GAME_TRACKING: 60 * 60 * 24, // 24 hours
} as const;

// Recap retry: 12 retries × 5 min interval = 1 hour max wait
export const MAX_RECAP_RETRIES = 12;
