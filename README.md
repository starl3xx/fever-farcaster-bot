# fever-farcaster-bot

Posts Indiana Fever WNBA game recaps to the `/fever` Farcaster channel.

A fork-in-spirit of [`cubs-farcaster-bot`](https://github.com/starl3xx/cubs-farcaster-bot).

## Architecture

```
  WNBA scoreboard (cdn.wnba.com)
            │  filter to gameStatus === Final + tricode IND
            ▼
  WNBA game page  ──▶  parse __NEXT_DATA__.highlightVideos
            │              pick "2-minute-game-recap" (free)
            ▼
  YouTube Data API v3  ──▶  search @WNBA / @indianafever
            │              score by team+date+"recap" keyword
            ▼
       yt-dlp  ──▶  mp4 buffer (<=720p)
            │
            ▼
  stream.farcaster.xyz (TUS upload)  ──▶  playback URL
            │
            ▼
  Farcaster /v2/casts  ──▶  /fever channel
```

## Setup

1. Copy `.env.example` to `.env.local` and fill in the values:
   - `NEYNAR_API_KEY`, `NEYNAR_SIGNER_UUID` — from Neynar dashboard.
   - `FARCASTER_CHANNEL_ID` — defaults to `fever`.
   - `FC_CUSTODY_MNEMONIC` — wallet mnemonic for the bot's Farcaster custody address (used to mint Farcaster session tokens for video casts).
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — Upstash Redis (or rename to `KV_REST_API_*` if using Vercel KV).
   - `CRON_SECRET` — any random string; Vercel sends it as a Bearer token to cron endpoints.
   - `YOUTUBE_API_KEY` — Google Cloud project key with YouTube Data API v3 enabled.
   - `BOT_ENABLED` — set to `true` to actually post (false = dry-run).

2. Install deps and the yt-dlp CLI (for local dev):
   ```bash
   npm install
   brew install yt-dlp   # macOS; Linux: pip install yt-dlp
   ```

3. Run locally:
   ```bash
   npm run dev
   curl -H "x-cron-secret: $CRON_SECRET" http://localhost:3000/api/cron/check-games
   ```

## Deploying to Vercel

`bin/yt-dlp_linux` is the Linux x86_64 static binary, committed to the repo and bundled into the cron function via `functions.includeFiles` in `vercel.json`. At runtime, `src/lib/yt-download.ts` resolves the binary path based on environment:
- `VERCEL=1` → `process.cwd()/bin/yt-dlp_linux`
- otherwise → `yt-dlp` on PATH (your local install)
- override with `YT_DLP_BIN=/absolute/path` to force a specific binary

### Updating the yt-dlp binary

YouTube changes formats periodically and yt-dlp ships frequent updates. Refresh the bundled binary roughly every 1–3 months (or when you notice extraction failing in logs):

```bash
curl -L -o bin/yt-dlp_linux \
  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
chmod +x bin/yt-dlp_linux
git add bin/yt-dlp_linux && git commit -m "Update yt-dlp binary"
```

## Known limitations

- **Experimental, single-team gate.** This bot only watches the WNBA scoreboard for `tricode === "IND"`. There is no fallback logic for postponed/suspended games, no news handling, no odds tracking — strictly Fever recaps.
- **YouTube extraction depends on the yt-dlp binary version.** When YT changes its format extractors, you need to refresh `bin/yt-dlp_linux` (see above). Logs will show `[yt-dlp] Exited with code N` when this happens.
