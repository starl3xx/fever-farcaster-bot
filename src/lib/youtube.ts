import { google, youtube_v3 } from "googleapis";
import { YOUTUBE_OFFICIAL_CHANNELS } from "./config";

interface FindRecapArgs {
  recapTitle: string;
  gameDateISO: string;
  homeTricode: string;
  awayTricode: string;
  homeName: string;
  awayName: string;
}

let cachedClient: youtube_v3.Youtube | null = null;

function getYoutubeClient(): youtube_v3.Youtube {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "YOUTUBE_API_KEY is not set. Add it to your env (and Vercel project) before running the bot."
    );
  }
  cachedClient = google.youtube({ version: "v3", auth: apiKey });
  return cachedClient;
}

/**
 * Score a YouTube result against the game we're trying to match.
 * Real-world @WNBA titles look like:
 *   "Portland Fire vs. Indiana Fever | FULL GAME HIGHLIGHTS | May 20, 2026"
 *
 * Scoring (max 5):
 *  - both full team names present → +2
 *  - title contains "highlights" or "recap" (case-insensitive) → +1
 *  - title contains the date in either YYYY-MM-DD or "Month DD, YYYY" form → +1
 *  - both team tricodes present (cheap tiebreaker) → +1
 */
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function formatHumanDate(iso: string): string {
  const d = new Date(iso);
  const month = MONTHS[d.getUTCMonth()];
  return `${month} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function scoreResult(
  title: string,
  homeTricode: string,
  awayTricode: string,
  homeName: string,
  awayName: string,
  gameDateISO: string
): number {
  const lower = title.toLowerCase();
  let score = 0;

  if (lower.includes(homeName.toLowerCase()) && lower.includes(awayName.toLowerCase())) {
    score += 2;
  }
  if (lower.includes("highlights") || lower.includes("recap")) {
    score += 1;
  }
  const ymd = gameDateISO.slice(0, 10);
  const human = formatHumanDate(gameDateISO).toLowerCase();
  if (lower.includes(ymd) || lower.includes(human)) {
    score += 1;
  }
  if (
    lower.includes(homeTricode.toLowerCase()) &&
    lower.includes(awayTricode.toLowerCase())
  ) {
    score += 1;
  }
  return score;
}

/**
 * Find the official YouTube recap video for a Fever game by searching the
 * official WNBA / Indiana Fever channels.
 *
 * Strategy:
 *  1. Try each channelId in YOUTUBE_OFFICIAL_CHANNELS sequentially.
 *  2. search.list with full team names + "highlights" within a +48h window
 *     starting at the game's date.
 *  3. Score every result; return the highest scorer if score >= 3; else null.
 */
export async function findRecapVideoId(
  args: FindRecapArgs
): Promise<string | null> {
  const { gameDateISO, homeTricode, awayTricode, homeName, awayName } = args;

  const yt = getYoutubeClient();

  const publishedAfter = new Date(gameDateISO).toISOString();
  const publishedBefore = new Date(
    new Date(gameDateISO).getTime() + 48 * 60 * 60 * 1000
  ).toISOString();
  const q = `${awayName} vs ${homeName} highlights`;

  let best: { videoId: string; score: number; title: string; channelId: string } | null = null;

  for (const channelId of Object.values(YOUTUBE_OFFICIAL_CHANNELS)) {
    try {
      const res = await yt.search.list({
        channelId,
        q,
        type: ["video"],
        part: ["snippet"],
        publishedAfter,
        publishedBefore,
        order: "date",
        maxResults: 5,
      });

      const items = res.data.items || [];
      for (const item of items) {
        const videoId = item.id?.videoId;
        const title = item.snippet?.title || "";
        if (!videoId || !title) continue;
        const score = scoreResult(
          title,
          homeTricode,
          awayTricode,
          homeName,
          awayName,
          gameDateISO
        );
        if (!best || score > best.score) {
          best = { videoId, score, title, channelId };
        }
      }
    } catch (err) {
      console.error(`[youtube] search failed for channel ${channelId}:`, err);
      // continue trying remaining channels
    }
  }

  if (best && best.score >= 3) {
    console.log(
      `[youtube] Matched recap: "${best.title}" (videoId=${best.videoId}, channel=${best.channelId}, score=${best.score})`
    );
    return best.videoId;
  }

  console.log(
    `[youtube] No confident match (best score=${best?.score ?? 0}, threshold>=3, best title="${best?.title ?? ""}")`
  );
  return null;
}
