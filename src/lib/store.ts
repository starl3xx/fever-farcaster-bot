import { Redis } from "@upstash/redis";
import { REDIS_KEYS, REDIS_TTL } from "./config";

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    // Vercel auto-injects KV_REST_API_* when a database is attached to a single
    // project, and `<prefix>_KV_REST_API_*` when the same db is shared across
    // projects (here the Cubs db is shared, so vars come in as `fever_KV_REST_API_*`).
    const url =
      process.env.KV_REST_API_URL ||
      process.env.fever_KV_REST_API_URL ||
      process.env.UPSTASH_REDIS_REST_URL;
    const token =
      process.env.KV_REST_API_TOKEN ||
      process.env.fever_KV_REST_API_TOKEN ||
      process.env.UPSTASH_REDIS_REST_TOKEN;
    redis = new Redis({ url: url!, token: token! });
  }
  return redis;
}

// Game dedup
export async function isGamePosted(gameId: string): Promise<boolean> {
  const result = await getRedis().get(`${REDIS_KEYS.GAME_POSTED}${gameId}`);
  return result !== null;
}

export async function markGamePosted(
  gameId: string,
  castHash: string
): Promise<void> {
  await getRedis().set(`${REDIS_KEYS.GAME_POSTED}${gameId}`, castHash, {
    ex: REDIS_TTL.GAME_POSTED,
  });
}

// Game recap tracking (retry counter)
export async function getGameTracking(gameId: string): Promise<number> {
  const result = await getRedis().get<number>(
    `${REDIS_KEYS.GAME_TRACKING}${gameId}`
  );
  return result ?? 0;
}

export async function incrementGameTracking(gameId: string): Promise<number> {
  const key = `${REDIS_KEYS.GAME_TRACKING}${gameId}`;
  const count = await getRedis().incr(key);
  // Set TTL on first increment
  if (count === 1) {
    await getRedis().expire(key, REDIS_TTL.GAME_TRACKING);
  }
  return count;
}

// Pending-games set — gameIds still being retried across day boundaries.
// Today's scoreboard only includes today's games, so without this set a
// game that rolls off the scoreboard before the recap downloads would
// become unreachable to the cron.
export async function addPendingGame(gameId: string): Promise<void> {
  await getRedis().sadd(REDIS_KEYS.PENDING_GAMES, gameId);
}

export async function removePendingGame(gameId: string): Promise<void> {
  await getRedis().srem(REDIS_KEYS.PENDING_GAMES, gameId);
}

export async function listPendingGames(): Promise<string[]> {
  const result = await getRedis().smembers(REDIS_KEYS.PENDING_GAMES);
  return Array.isArray(result) ? result.map(String) : [];
}

// Health check
export async function getRedisStatus(): Promise<{
  connected: boolean;
  error?: string;
}> {
  try {
    await getRedis().ping();
    return { connected: true };
  } catch (err) {
    return {
      connected: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
