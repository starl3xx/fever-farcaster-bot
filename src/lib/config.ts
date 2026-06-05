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
  GAME_POSTED: "fever:game:", // fever:game:{gameId} → cast hash (native video, final)
  GAME_TRACKING: "fever:track:", // fever:track:{gameId} → retry count
  GAME_LOCK: "fever:lock:", // fever:lock:{gameId} → serialization lock
  PENDING_GAMES: "fever:pending", // Set of gameIds being retried across days
  NEWS_POSTED: "fever:news:", // fever:news:{espnArticleId} → cast hash
  GAME_FALLBACK: "fever:fallback:", // fever:fallback:{gameId} → {hash,fid} of the
                                    // provisional image-fallback cast, kept so a
                                    // later-arriving mp4 can reply to it with video
} as const;

export const REDIS_TTL = {
  GAME_POSTED: 60 * 60 * 24 * 30, // 30 days
  // Tracking counter TTL. incrementGameTracking() slides this on every
  // increment, so it only needs to outlive the GAP between real-processing
  // runs (~15 min under the per-game lock), not the whole retry climb. 6h is
  // ample headroom and also GCs the counter once increments stop.
  GAME_TRACKING: 60 * 60 * 6,
  // Lock TTL must exceed function maxDuration (600s) so a crashed invocation
  // can't leave the lock held indefinitely, but is short enough that real
  // failures recover within a couple cron intervals.
  GAME_LOCK: 700,
  NEWS_POSTED: 60 * 60 * 24 * 14, // 14 days — well beyond NEWS_LOOKBACK so
                                  // an article can't slip back into the
                                  // window after its dedup record expires
  GAME_FALLBACK: 60 * 60 * 48, // 48h — must outlive RECAP_UPGRADE_WINDOW_MS so
                               // the fallback cast's {hash,fid} is still readable
                               // when a near-deadline mp4 arrives to upgrade it
} as const;

// Recap retry: how many real-processing runs to wait for the team-site mp4
// before posting the non-video IMAGE fallback (the recap thumbnail). The
// effective cadence is NOT the 5-min cron — the per-game lock (GAME_LOCK = 700s)
// is held across non-success runs, so real processing (and thus each increment)
// happens only ~once per 15 min. 12 ≈ 3h, giving the WNBA team site (usually
// publishes within an hour or two of final) time to post before we show users
// *something*; a late mp4 still upgrades the image to a native-video reply
// within RECAP_UPGRADE_WINDOW_MS. Kept modest because this same counter also
// gates the "no recap metadata, give up" branch (which posts nothing), so we
// don't want to abandon a flaky game-page fetch too eagerly. If you change
// GAME_LOCK, revisit this — the lock cadence is what maps retries to wall time.
export const MAX_RECAP_RETRIES = 12;

// After the image fallback posts we keep polling the team-site CDN for the mp4
// for this long past tip-off; if it appears we reply to the fallback cast with
// the native video (an upgrade). Late West-coast road games occasionally publish
// the morning after, so this brackets a full next-day cycle. If it never appears
// (some road games are never minted as a team-site mp4), the image fallback
// simply stands and the game drops out of the pending rotation at the deadline.
export const RECAP_UPGRADE_WINDOW_MS = 36 * 60 * 60 * 1000;

// News: ESPN's team-filtered news endpoint. team=5 is the Indiana Fever's
// internal ESPN team id. The endpoint returns ~50 items at limit=50 and is
// fully free (every article has premium:false). We filter by type to avoid
// re-posting content the recap bot already covers.
export const ESPN_FEVER_NEWS_URL =
  "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/news?team=5&limit=50";

// Consider articles published in the last 4 hours. The cron runs every 2hr,
// so 4hr gives a 2hr safety margin against ESPN publish-time jitter and
// cron mis-firings without surfacing day-old "news".
export const NEWS_LOOKBACK_MS = 4 * 60 * 60 * 1000;

// ESPN article types we actually want to post. Recap/Preview/Media overlap
// with this bot's own recap casts; HeadlineNews and Story are the editorial
// feature buckets where we'd add real value.
export const NEWS_POSTABLE_TYPES = ["HeadlineNews", "Story"] as const;
