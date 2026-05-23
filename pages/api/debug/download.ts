import type { NextApiRequest, NextApiResponse } from "next";
import { downloadYouTubeMp4 } from "../../../src/lib/yt-download";

/**
 * Diagnostic endpoint — runs the yt-dlp download path against a videoId and
 * returns size + elapsed without posting to Farcaster or marking the game
 * as posted. Useful for iterating on 1080p / proxy settings without burning
 * a "real" cast slot.
 *
 * GET /api/debug/download?videoId=XXX
 * Header: x-cron-secret: <CRON_SECRET>
 *
 * Set YT_DLP_VERBOSE=1 in env to enable yt-dlp -v output.
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
  const result = await downloadYouTubeMp4(videoId);
  const elapsedMs = Date.now() - start;

  if (!result) {
    return res.status(200).json({
      ok: false,
      videoId,
      elapsedMs,
      message: "Download failed — see logs",
    });
  }

  return res.status(200).json({
    ok: true,
    videoId,
    elapsedMs,
    sizeBytes: result.buffer.length,
    sizeMB: (result.buffer.length / 1024 / 1024).toFixed(1),
  });
}
