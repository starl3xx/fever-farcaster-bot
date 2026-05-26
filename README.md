# fever-farcaster-bot

Posts Indiana Fever WNBA game recaps and news to the [`/fever`](https://farcaster.xyz/~/channel/fever) Farcaster channel — native inline video on recaps, ESPN-sourced article cards on news.

A fork-in-spirit of [`cubs-farcaster-bot`](https://github.com/starl3xx/cubs-farcaster-bot).

## Cast format

```
🏀 FINAL: Fever 90, Valkyries 82

🏆 Top performers
1️⃣ Aliyah Boston: 20 PTS, 16 REB, 3 AST
2️⃣ Caitlin Clark: 22 PTS, 2 REB, 9 AST

📋 Record/streak/rank: 4-2 (0.667) / W3 / 2nd in E. Conference
```

Top performers are ranked by **NBA Efficiency** (`(PTS+REB+AST+STL+BLK) − ((FGA−FGM)+(FTA−FTM)+TOV)`), not raw points. The Fever team is always listed first in the score line. Standings come from `wnba.com/standings` and degrade gracefully if the fetch fails.

## Architecture

```
  WNBA scoreboard (cdn.wnba.com)
            │  filter to gameStatus === Final + tricode IND
            │  union with pending-games set (cross-day rollover)
            ▼
  WNBA boxscore  ──▶  team scores + per-player stats (PTS/REB/AST/...)
            │
            ▼
  WNBA game page  ──▶  parse __NEXT_DATA__.highlightVideos
            │            pick "2-minute-game-recap" (free) for permalink fallback
            ▼
  WNBA standings page  ──▶  Fever record / streak / conference rank
            │
            ▼
  videos.nba.com (Fever team-site CDN)
            │  HEAD-check highlights-{YYMMDD}_1280x720.mp4 (game date in ET)
            │  publish lag is typically 45 min – 2 hr after final buzzer
            ▼
  Clean 720p H.264/AAC mp4 download
            │
            ▼
  stream.farcaster.xyz (TUS upload, 20 MB chunks)
            │  poll for state=ready + embed-classifier confirmation
            ▼
  Farcaster /v2/casts  ──▶  /fever channel
```

The video source — `https://videos.nba.com/wordpress/uploads/media/sites/fever/{YYYY}/{MM}/highlights-{YYMMDD}_1280x720.mp4` — is the WNBA's WordPress media CDN, served unauthenticated via CloudFront. The `{YYMMDD}` segment uses the game's local Eastern Time date. No re-encoding required: the mp4 is already H.264/AAC in a clean MP4 container and goes straight to Farcaster's stream service.

## Setup

1. Copy `.env.example` to `.env.local` and fill in the values:
   - `NEYNAR_API_KEY`, `NEYNAR_SIGNER_UUID` — from the Neynar dashboard.
   - `FARCASTER_CHANNEL_ID` — defaults to `fever`.
   - `FC_CUSTODY_MNEMONIC` — wallet mnemonic for the bot's Farcaster custody address (used to mint Farcaster session tokens for video casts).
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — Upstash Redis (or rename to `KV_REST_API_*` if using Vercel KV).
   - `CRON_SECRET` — any random string; Vercel sends it as a Bearer token to cron endpoints.
   - `BOT_ENABLED` — set to `true` to actually post recaps (false = dry-run; logs the cast but skips Neynar / Farcaster API).
   - `NEWS_ENABLED` — set to `true` to enable the news cron. Independent of `BOT_ENABLED` so the two pipelines can be ramped separately.

2. Install deps:
   ```bash
   npm install
   ```

3. Run locally:
   ```bash
   npm run dev
   curl -H "x-cron-secret: $CRON_SECRET" http://localhost:3000/api/cron/check-games
   curl -H "x-cron-secret: $CRON_SECRET" http://localhost:3000/api/cron/check-news
   ```

## News

A second cron (`/api/cron/check-news`, `0 */2 * * *`) posts Fever news from ESPN's team-filtered site-API (`site.api.espn.com/apis/site/v2/sports/basketball/wnba/news?team=5`). Gated by `NEWS_ENABLED=true` separately from `BOT_ENABLED` so you can ramp it independently.

- **Source:** ESPN team-news JSON, fully free (`premium: false` enforced as defense-in-depth).
- **Filter:** only `type ∈ {HeadlineNews, Story}`. Recap/Preview/Media items are dropped because they'd duplicate this bot's own game-recap casts.
- **Lookback:** articles published in the last 4 hours. The 2-hr cron gives 2 hr of headroom.
- **Dedup:** by ESPN's stable numeric article id (`fever:news:{id}` in Redis, 14-day TTL).
- **Backlog order:** when multiple new items are found in one cron tick, they're posted oldest-first so the channel feed reads chronologically.

Cast format:

```
📣 Fever news: WNBA Power Rankings: Fever crack top 5, Dream take over No. 1

✍️ Michael Voepel | Read more 👇
```

Farcaster unfurls the ESPN URL into a card with the article's hero image — no extra embed work needed.

## Recap cron behavior

- **Schedule**: every 5 minutes (`*/5 * * * *`), endpoint `/api/cron/check-games`. Gated by `BOT_ENABLED=true`.
- **Per-game lock**: `processGame` acquires a Redis lock (`fever:lock:{gameId}`, `SET NX EX 700`) before any work. Cron concurrency previously caused duplicate casts when the pipeline outran the 5-minute interval; the lock serializes per-game work. Released on a successful post; on failure it rides out the TTL so retries don't tight-loop.
- **Retry window**: 24 attempts × 5 min = **2 hours** per game (`MAX_RECAP_RETRIES` in `src/lib/config.ts`). This matches the typical WNBA team-site upload lag with margin. After exhausting retries, the bot posts with the WNBA watch-page URL as a non-video embed so users still get a cast.
- **Cross-day persistence**: today's WNBA scoreboard only lists today's games. Once a game first appears as `Final`, its `gameId` is added to a Redis pending-games set (`fever:pending`) and stays there until the cast posts or retries exhaust. This keeps games alive through next-day scoreboard rollover.
- **Embed verification**: `pollForReady` waits for the upload to reach `state=ready` (not just for an embed URL to appear); `waitForEmbedReady` then HEADs the URL until the CDN serves it and gives the embed classifier ~30s to index. If either step times out, the upload is treated as a failure and the retry counter advances rather than posting a URL that would render without a video card.

## Known limitations

- **Quality is capped at 720p.** The Fever team-site CDN only serves `_1280x720.mp4`; `_1920x1080`, `_full`, and bare `.mp4` all return 403. A 1080p path via YouTube DASH (formats `137+140` + `-c copy` mux) is possible but reinstates the yt-dlp + ffmpeg + residential-proxy dependency stack — see "Legacy YouTube pipeline" below.
- **Publish lag.** The WNBA digital team uploads the recap mp4 typically 45 min – 2 hr after the final buzzer; an outlier of ~37 hr was observed once (probably a re-upload). The 2-hr retry window covers the normal case; the cross-day pending set catches outliers.
- **Editor-curated source.** If the digital team doesn't publish a highlight for a given game, the bot falls back to a non-video cast with the WNBA watch-page URL.
- **Experimental, single-team gate.** Only watches the WNBA scoreboard for `tricode === "IND"`. No odds tracking — strictly Fever recaps + news.

## Legacy YouTube pipeline (deprecated)

The repo retains the original yt-dlp + ffmpeg + Decodo-residential-proxy pipeline (`src/lib/yt-download.ts`, `src/lib/youtube.ts`, the deprecated `uploadRemuxedToFarcasterStream` in `src/lib/video.ts`, and bundled binaries in `bin/`). It's wired into the `/api/debug/download` and `/api/debug/list-formats` routes only — not the post path. Kept as a reference for the 1080p path if Decodo egress quality ever supports it, and so the debug routes keep working.

To remove it for a smaller deploy bundle: delete `bin/`, `src/lib/yt-download.ts`, `src/lib/youtube.ts`, the deprecated function in `src/lib/video.ts`, the two debug routes, the `includeFiles: "bin/**"` line in `vercel.json`, and the `DECODO_PROXY` / `YOUTUBE_API_KEY` env vars.
