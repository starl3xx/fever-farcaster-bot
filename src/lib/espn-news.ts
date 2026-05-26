import {
  ESPN_FEVER_NEWS_URL,
  NEWS_LOOKBACK_MS,
  NEWS_POSTABLE_TYPES,
} from "./config";

/**
 * A Fever news item we'd consider posting. Sourced from ESPN's
 * site-api `/news?team=5` endpoint — see ESPN_FEVER_NEWS_URL.
 */
export interface FeverNewsItem {
  id: number;
  headline: string;
  description: string;
  byline?: string;
  publishedAt: Date;
  url: string;
  type: string;
}

interface EspnNewsResponse {
  articles?: EspnArticle[];
}

interface EspnArticle {
  id: number;
  headline: string;
  description?: string;
  byline?: string;
  published: string;
  type: string;
  premium?: boolean;
  links?: { web?: { href?: string } };
}

/**
 * Fetch ESPN's Fever team-news feed, filter to items worth posting, and
 * return them newest-first.
 *
 * Filters applied:
 *   - non-premium only (defense in depth; the team-news endpoint is fully
 *     free today but ESPN could add paywalled items later)
 *   - type ∈ NEWS_POSTABLE_TYPES (HeadlineNews + Story). Recap/Preview/Media
 *     overlap with our own game-recap casts; skipping them avoids dupes
 *   - published in the last NEWS_LOOKBACK_MS so the cron doesn't surface
 *     stale items after a long outage
 *
 * Dedup against already-posted articles happens at the caller level
 * via the Redis NEWS_POSTED key.
 */
export async function fetchFeverNews(): Promise<FeverNewsItem[]> {
  const res = await fetch(ESPN_FEVER_NEWS_URL, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`ESPN news fetch failed: ${res.status}`);
  }
  const data = (await res.json()) as EspnNewsResponse;
  const articles = data.articles || [];

  const cutoff = Date.now() - NEWS_LOOKBACK_MS;
  const allowedTypes = new Set<string>(NEWS_POSTABLE_TYPES);

  return articles
    .filter((a) => !a.premium)
    .filter((a) => allowedTypes.has(a.type))
    .map<FeverNewsItem | null>((a) => {
      const url = a.links?.web?.href;
      if (!url || !a.id || !a.headline) return null;
      return {
        id: a.id,
        headline: a.headline,
        description: a.description || "",
        byline: a.byline || undefined,
        publishedAt: new Date(a.published),
        url,
        type: a.type,
      };
    })
    .filter((x): x is FeverNewsItem => x !== null)
    .filter((x) => x.publishedAt.getTime() > cutoff)
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}
