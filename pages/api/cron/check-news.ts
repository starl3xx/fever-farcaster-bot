import type { NextApiRequest, NextApiResponse } from "next";
import { fetchFeverNews } from "../../../src/lib/espn-news";
import { formatNewsCast } from "../../../src/lib/formatter";
import { postToChannel } from "../../../src/lib/neynar";
import { isNewsPosted, markNewsPosted } from "../../../src/lib/store";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (!verifyAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (process.env.NEWS_ENABLED !== "true") {
    return res
      .status(200)
      .json({ ok: true, message: "News posting disabled (NEWS_ENABLED != true)" });
  }

  try {
    const items = await fetchFeverNews();
    const results: Record<string, string> = {};

    // Process newest-last so a backlog posts chronologically in the
    // channel feed (oldest-first appearance).
    for (const item of [...items].reverse()) {
      const key = String(item.id);
      if (await isNewsPosted(item.id)) {
        results[key] = "already posted";
        continue;
      }

      const text = formatNewsCast(item.headline, item.byline, item.url);
      const result = await postToChannel(text, {
        embeds: [{ url: item.url }],
        idem: `fever-news-${item.id}`,
      });

      if (result.hash) {
        await markNewsPosted(item.id, result.hash);
        results[key] = `posted (${item.type}): ${result.hash}`;
      } else {
        results[key] = `failed (${item.type}): ${result.error}`;
      }
    }

    return res.status(200).json({
      ok: true,
      itemsConsidered: items.length,
      results,
    });
  } catch (err) {
    console.error("[check-news] Error:", err);
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
}

function verifyAuth(req: NextApiRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  // Vercel cron sends this header automatically
  const authHeader = req.headers.authorization;
  if (authHeader === `Bearer ${secret}`) return true;

  // Also check the x-cron-secret header (for manual testing)
  if (req.headers["x-cron-secret"] === secret) return true;

  return false;
}
