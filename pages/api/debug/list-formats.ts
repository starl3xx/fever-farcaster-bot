import type { NextApiRequest, NextApiResponse } from "next";
import { listFormats } from "../../../src/lib/yt-download";

/**
 * Diagnostic endpoint — runs `yt-dlp --list-formats` against a videoId and
 * returns the raw format table. Consumes minimal proxy bandwidth (metadata
 * only, no video bytes).
 *
 * GET /api/debug/list-formats?videoId=XXX
 * Header: x-cron-secret: <CRON_SECRET>
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const videoId = String(req.query.videoId || "");
  if (!videoId) {
    return res.status(400).json({ error: "Missing videoId" });
  }

  const start = Date.now();
  const output = await listFormats(videoId);
  const elapsedMs = Date.now() - start;

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.status(200).send(`elapsedMs=${elapsedMs}\n\n${output}`);
}
