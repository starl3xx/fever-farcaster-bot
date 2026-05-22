import { Redis } from "@upstash/redis";
import { REDIS_KEYS, REDIS_TTL } from "./config";

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis({
      url: (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL)!,
      token: (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)!,
    });
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
