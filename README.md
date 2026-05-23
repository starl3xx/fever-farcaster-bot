# fever-farcaster-bot

Posts Indiana Fever WNBA game recaps to the [`/fever`](https://farcaster.xyz/~/channel/fever) Farcaster channel — native inline video, top performers, and live standings.

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
            │              pick "2-minute-game-recap" (free)
            ▼
  YouTube Data API v3  ──▶  search @WNBA / @indianafever
            │              score by team + date + "recap" keyword
            ▼
  WNBA standings page  ──▶  Fever record / streak / conference rank
            │
            ▼
  yt-dlp + ffmpeg  ──▶  1080p mp4 buffer (via residential proxy)
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
   - `DECODO_PROXY` — Decodo residential proxy creds in their native `host:port:user:pass` format. **Required for production** — without it, YouTube's bot challenge blocks downloads from Vercel IPs. See "Residential proxy" below.
   - `BOT_ENABLED` — set to `true` to actually post (false = dry-run; logs the cast but skips Neynar).

2. Install deps and the yt-dlp / ffmpeg CLIs (for local dev):
   ```bash
   npm install
   brew install yt-dlp ffmpeg   # macOS; Linux: apt/pip equivalents
   ```

3. Run locally:
   ```bash
   npm run dev
   curl -H "x-cron-secret: $CRON_SECRET" http://localhost:3000/api/cron/check-games
   ```

## Bundled binaries (`bin/`)

| Binary | Size | Purpose |
|---|---|---|
| `yt-dlp_linux` | 34 MB | YouTube downloader (latest release, Linux x86_64 static) |
| `qjs` | 2 MB | QuickJS-NG — JS runtime yt-dlp needs to execute YouTube's player JS |
| `ffmpeg` | 76 MB | Remuxes YouTube's separate 1080p video and audio DASH streams into a single mp4 |

All three are shipped to the cron function via `functions.includeFiles: "bin/**"` in `vercel.json`. The runtime at `src/lib/yt-download.ts` resolves paths based on environment:

- `VERCEL=1` → `process.cwd()/bin/<binary>`
- otherwise → resolves on `PATH` (your local install)
- override with `YT_DLP_BIN`, `YT_DLP_QJS_BIN`, `YT_DLP_FFMPEG_BIN` for explicit paths

### Updating the bundled binaries

YouTube changes formats periodically; yt-dlp ships frequent updates. Refresh roughly every 1–3 months (or when you notice extraction failing in logs):

```bash
# yt-dlp
curl -L -o bin/yt-dlp_linux \
  https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux
chmod +x bin/yt-dlp_linux

# ffmpeg (76MB, John Van Sickle's static build)
curl -L -o /tmp/ff.tar.xz \
  https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
tar xJf /tmp/ff.tar.xz -C /tmp
cp /tmp/ffmpeg-*-amd64-static/ffmpeg bin/ffmpeg
chmod +x bin/ffmpeg
rm -rf /tmp/ffmpeg-*-amd64-static /tmp/ff.tar.xz

# qjs (rarely changes)
curl -L -o bin/qjs \
  https://github.com/quickjs-ng/quickjs/releases/latest/download/qjs-linux-x86_64
chmod +x bin/qjs

git add bin/ && git commit -m "Refresh bundled binaries"
```

## Residential proxy

YouTube's anti-bot system blocks the "video bytes" path from datacenter IPs (Vercel iad1 / AWS us-east-1) with `Sign in to confirm you're not a bot`. The bot routes yt-dlp through a [Decodo](https://decodo.com) residential proxy via `--proxy`, which presents as a real residential IP and bypasses the challenge.

- **Format**: Decodo gives credentials as `host:port:user:pass`. Set the whole string verbatim as `DECODO_PROXY`. The code splits on `:` and reformats to `http://user:pass@host:port` with URL-encoded credentials.
- **Recommended plan**: Pay-As-You-Go ($8.50/GB, no monthly commitment). A 1080p recap is ~100–200 MB, so an entire WNBA season is well under 10 GB.
- **What if it's unset**: `yt-dlp` runs without a proxy. You'll either get the bot challenge (failure) or, when the override below is also missing, hang waiting on ffmpeg. Production must have `DECODO_PROXY` set.

## Cron behavior

- **Schedule**: every 5 minutes (`*/5 * * * *`).
- **Retry window**: 24 attempts × 5 min = **2 hours** per game (`MAX_RECAP_RETRIES` in `src/lib/config.ts`). After exhausting retries on the video download, the bot falls back to a YouTube-URL embed so users still get a cast.
- **Cross-day persistence**: today's WNBA scoreboard only lists today's games. Once a game first appears as `Final`, its `gameId` is added to a Redis pending-games set (`fever:pending`) and stays there until the cast posts or retries exhaust. This keeps games alive through next-day scoreboard rollover.
- **Function timeout**: 600s (`vercel.json` → `maxDuration`). A 1080p recap download through a residential proxy plus ffmpeg remux can take 1–3 min; 600s gives comfortable headroom.

## Known limitations

- **Experimental, single-team gate.** Only watches the WNBA scoreboard for `tricode === "IND"`. No fallback logic for postponed/suspended games, no news handling, no odds tracking — strictly Fever recaps.
- **YouTube extraction depends on the yt-dlp binary version.** When YT changes its format extractors, refresh `bin/yt-dlp_linux` (see above). Logs will show `[yt-dlp] Exited with code N`.
- **Proxy budget is finite.** A 3 GB Decodo plan covers ~15–25 1080p recaps. Monitor Decodo's "Used Traffic" dashboard mid-season.
- **No 1080p without ffmpeg.** Removing `bin/ffmpeg` falls back to 360p combined-stream downloads (YouTube only exposes 1080p as separate DASH streams that require remuxing).
