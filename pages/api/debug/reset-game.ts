import type { NextApiRequest, NextApiResponse } from "next";
import { Redis } from "@upstash/redis";
import { REDIS_KEYS } from "../../../src/lib/config";

/**
 * Diagnostic endpoint — clears the "posted" and "pending" state for a
 * specific gameId so the cron will re-process it on the next tick.
 * Useful for end-to-end testing without waiting for a fresh game.
 *
 * GET /api/debug/reset-game?gameId=XXX
 * Header: x-cron-secret: <CRON_SECRET>
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const gameId = String(req.query.gameId || "");
  if (!gameId) return res.status(400).json({ error: "Missing gameId" });

  const url =
    process.env.KV_REST_API_URL ||
    process.env.fever_KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.fever_KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN;
  const redis = new Redis({ url: url!, token: token! });

  const postedKey = `${REDIS_KEYS.GAME_POSTED}${gameId}`;
  const trackingKey = `${REDIS_KEYS.GAME_TRACKING}${gameId}`;
  const lockKey = `${REDIS_KEYS.GAME_LOCK}${gameId}`;
  const fallbackKey = `${REDIS_KEYS.GAME_FALLBACK}${gameId}`;
  // SADD pending so the cron picks the game up next tick, even after
  // the WNBA scoreboard has rolled over and no longer lists it as today's.
  const [
    postedDeleted,
    trackingDeleted,
    lockDeleted,
    fallbackDeleted,
    pendingAdded,
  ] = await Promise.all([
    redis.del(postedKey),
    redis.del(trackingKey),
    redis.del(lockKey),
    redis.del(fallbackKey),
    redis.sadd(REDIS_KEYS.PENDING_GAMES, gameId),
  ]);

  return res.status(200).json({
    ok: true,
    gameId,
    cleared: {
      [postedKey]: postedDeleted,
      [trackingKey]: trackingDeleted,
      [lockKey]: lockDeleted,
      [fallbackKey]: fallbackDeleted,
    },
    pending_added: pendingAdded,
  });
}
