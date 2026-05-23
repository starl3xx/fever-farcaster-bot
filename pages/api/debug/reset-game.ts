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
  const [postedDeleted, trackingDeleted, pendingRemoved] = await Promise.all([
    redis.del(postedKey),
    redis.del(trackingKey),
    redis.srem(REDIS_KEYS.PENDING_GAMES, gameId),
  ]);

  return res.status(200).json({
    ok: true,
    gameId,
    cleared: {
      [postedKey]: postedDeleted,
      [trackingKey]: trackingDeleted,
      [`${REDIS_KEYS.PENDING_GAMES} (sadd member)`]: pendingRemoved,
    },
  });
}
