/**
 * yt-dlp wrapper — downloads a YouTube video as a single mp4 buffer.
 *
 * Runtime:
 *   - On Vercel: invokes the bundled Linux x86_64 binaries at `bin/yt-dlp_linux`,
 *     `bin/qjs`, and `bin/ffmpeg` (all shipped via `functions.includeFiles`
 *     in vercel.json).
 *   - Locally: shells out to system `yt-dlp` / `ffmpeg` on PATH.
 *
 * To force the bundled binaries in a non-Vercel environment, set
 * YT_DLP_BIN, YT_DLP_QJS_BIN, and/or YT_DLP_FFMPEG_BIN to absolute paths.
 *
 * QuickJS is bundled (2MB) to satisfy yt-dlp's JS-runtime requirement for
 * the new YouTube extractor — without one, yt-dlp warns "No supported
 * JavaScript runtime could be found" and falls back to incomplete extraction.
 * Deno would also work but its 110MB binary exceeds GitHub's 100MB limit.
 *
 * ffmpeg (76MB) is required to remux YouTube's separate 1080p video and
 * audio DASH streams into a single mp4. Without it, yt-dlp either hangs or
 * silently falls back to the 360p combined format. We download to a
 * tempfile (not stdout) because mp4's moov atom requires seekable output
 * and stdout-piping breaks the muxer.
 *
 * Egress: when DECODO_PROXY is set, yt-dlp routes through a residential
 * proxy and YouTube's "Sign in to confirm you're not a bot" challenge is
 * bypassed. We let yt-dlp pick its default player_client(s) so we get the
 * full DASH manifest (separate video+audio streams up to 1080p).
 */
import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

function resolveYtDlpBin(): string {
  if (process.env.YT_DLP_BIN) return process.env.YT_DLP_BIN;
  if (process.env.VERCEL) {
    return path.join(process.cwd(), "bin", "yt-dlp_linux");
  }
  return "yt-dlp";
}

function resolveQjsBin(): string | null {
  if (process.env.YT_DLP_QJS_BIN) return process.env.YT_DLP_QJS_BIN;
  if (process.env.VERCEL) {
    return path.join(process.cwd(), "bin", "qjs");
  }
  return null;
}

function resolveFfmpegLocation(): string | null {
  if (process.env.YT_DLP_FFMPEG_BIN) return process.env.YT_DLP_FFMPEG_BIN;
  if (process.env.VERCEL) {
    // Pass the bin/ directory rather than the ffmpeg binary path so yt-dlp
    // also discovers ffprobe sibling. With just the binary path, yt-dlp
    // can't find ffprobe and HLS post-processing fails.
    return path.join(process.cwd(), "bin");
  }
  // Locally, let yt-dlp find ffmpeg on PATH. If it's missing, yt-dlp falls
  // back to the best combined-stream format (usually 360p).
  return null;
}

/**
 * Parse Decodo's `host:port:user:pass` credentials format and return a
 * yt-dlp-compatible `http://user:pass@host:port` proxy URL. The password
 * is URL-encoded — Decodo passwords routinely contain `+`, `/`, etc., which
 * break userinfo parsing otherwise. Returns null when DECODO_PROXY is unset.
 */
function resolveProxyUrl(): string | null {
  const raw = process.env.DECODO_PROXY;
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length < 4) {
    console.warn(
      "[yt-dlp] DECODO_PROXY malformed; expected host:port:user:pass"
    );
    return null;
  }
  const [host, port, user] = parts;
  const pass = parts.slice(3).join(":");
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(
    pass
  )}@${host}:${port}`;
}

/** Strip userinfo from a proxy URL so it can be logged without leaking creds. */
function redactProxy(url: string): string {
  return url.replace(/\/\/[^@]+@/, "//<creds>@");
}

/**
 * Run `yt-dlp --list-formats` for diagnostic purposes. Streams output to
 * the log so we can see exactly which formats YouTube exposes through the
 * proxy. Consumes minimal bandwidth (no video bytes downloaded).
 */
export async function listFormats(videoId: string): Promise<string> {
  const url = `https://youtube.com/watch?v=${videoId}`;
  const qjsBin = resolveQjsBin();
  const proxyUrl = resolveProxyUrl();
  const args = [
    "--list-formats",
    "--socket-timeout",
    "30",
    ...(qjsBin ? ["--js-runtimes", `quickjs:${qjsBin}`] : []),
    ...(proxyUrl ? ["--proxy", proxyUrl] : []),
    url,
  ];
  const bin = resolveYtDlpBin();
  const safeArgs = proxyUrl
    ? args.map((a) => (a === proxyUrl ? redactProxy(a) : a))
    : args;
  console.log(`[yt-dlp] Spawning: ${bin} ${safeArgs.join(" ")}`);

  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (c: Buffer) => {
      const s = c.toString();
      out += s;
      console.log(`[yt-dlp:out] ${s.trimEnd()}`);
    });
    proc.stderr.on("data", (c: Buffer) => {
      const s = c.toString();
      out += s;
      console.log(`[yt-dlp:err] ${s.trimEnd()}`);
    });
    proc.on("error", (err) => {
      console.error("[yt-dlp] Spawn error:", err);
      resolve(out);
    });
    proc.on("close", () => resolve(out));
  });
}

export interface DownloadResult {
  filePath: string;
  sizeBytes: number;
  duration: number;
}

/**
 * Downloads the recap video to a tempfile on disk and returns the path +
 * size. The caller is responsible for deleting the tempfile after use
 * (usually via the upload pipeline, which streams from disk).
 *
 * NB: returns a path, not a buffer. A 1080p recap is ~330MB; loading it
 * into a Node Buffer and copying it (`new Uint8Array(buf)`) blows past
 * Vercel's 2GB function memory once fetch's TUS body buffer is added on
 * top. Streaming from disk to fetch keeps peak memory under ~100MB.
 */
export async function downloadYouTubeMp4(
  videoId: string
): Promise<DownloadResult | null> {
  const url = `https://youtube.com/watch?v=${videoId}`;
  const tempPath = path.join(os.tmpdir(), `recap-${videoId}-${Date.now()}.mp4`);

  // Sweep orphans from previous invocations. Vercel reuses function instances
  // warmly across cron ticks, so /tmp persists across runs. An earlier SIGKILL
  // or ENOSPC crash can leave:
  //   - recap-*.mp4: 100-300MB yt-dlp source files
  //   - encoded-*.mkv: 50-150MB ffmpeg outputs from the upload step
  //   - _MEI*/ directories: PyInstaller's partial yt-dlp extraction; if the
  //     prior crash truncated this, the next yt-dlp launch fails with
  //     "Failed to extract curl_cffi/..." until the dir is rebuilt
  // /tmp is only 512MB on Vercel; any orphan is fatal.
  try {
    const tmpDir = os.tmpdir();
    const entries = await fs.readdir(tmpDir);
    for (const name of entries) {
      const full = path.join(tmpDir, name);
      if (
        (name.startsWith("recap-") && name.endsWith(".mp4")) ||
        (name.startsWith("encoded-") &&
          (name.endsWith(".mp4") || name.endsWith(".mkv")))
      ) {
        await fs.unlink(full).catch(() => {});
      } else if (name.startsWith("_MEI")) {
        await fs.rm(full, { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch (err) {
    console.warn("[yt-dlp] tmp sweep failed (non-fatal):", err);
  }

  return new Promise((resolve) => {
    const qjsBin = resolveQjsBin();
    const ffmpegLocation = resolveFfmpegLocation();
    const proxyUrl = resolveProxyUrl();
    // WNBA recap videos on YouTube expose 720p/1080p only as HLS m3u8
    // streams (no direct https). Through the Decodo residential proxy,
    // parallel HLS fragment downloads trigger Cloudflare 522 retry storms,
    // and 1080p serial downloads hit `[SSL] record layer failure` retries
    // partway through because the residential IP destabilizes on long
    // sustained pulls. 720p (~100MB, ~2min) finishes before that happens.
    //
    // We force an explicit format ID ladder so yt-dlp picks the highest-res
    // HLS we want without going off-script: 96=1080p, 95=720p, 94=480p,
    // 93=360p HLS, 18=360p direct https. Set YT_DLP_MAX_HEIGHT=1080 to
    // retest 1080p if proxy quality ever improves.
    const maxHeight = process.env.YT_DLP_MAX_HEIGHT || "720";
    // Format ladder by resolution descending, English-language preferred,
    // then any-language. Cap at maxHeight by trimming the front of the list.
    const ladder = [
      { id: "96", height: 1080 },
      { id: "95", height: 720 },
      { id: "94", height: 480 },
      { id: "93", height: 360 },
      { id: "18", height: 360 }, // 360p direct https (no HLS)
    ];
    const ladderIds = ladder
      .filter((f) => f.height <= Number(maxHeight))
      .flatMap((f) => (f.id === "18" ? ["18"] : [`${f.id}-8`, f.id]));
    const formatSelector =
      ladderIds.join("/") + `/b[height<=${maxHeight}]`;

    const verbose = process.env.YT_DLP_VERBOSE === "1";
    const args = [
      "-f",
      formatSelector,
      // Bias toward resolution. By default yt-dlp prefers https-direct
      // streams over HLS m3u8 when "best" is close — that meant `b[height<=720]`
      // picked format 18 (360p direct) over format 95 (720p HLS). Explicitly
      // sorting by resolution-descending forces 720p HLS when available.
      "--format-sort",
      "res,vcodec:avc1,acodec:mp4a",
      "--merge-output-format",
      "mp4",
      "--socket-timeout",
      "30",
      // Suppress per-fragment progress lines. At 25+ MiB/s through Bright
      // Data ISP, a 120-fragment HLS download generates 6000+ progress
      // lines in seconds — Vercel's log buffer caps at 256 messages per
      // request, so the actual exit/error info gets dropped. We keep
      // [info]/[error] lines which carry the diagnostics we care about.
      "--no-progress",
      // Skip yt-dlp's FixupM3u8 step. The default fixup writes a remuxed
      // temp file alongside the original (in-place "fix"), which doubles
      // /tmp usage and breaks on 1080p (337 MB × 2 > Vercel's 512 MB /tmp).
      // The output is still MPEG-TS-in-MP4, which Cloudflare Stream
      // (Farcaster Stream's backend) ingests fine and re-encodes itself.
      "--fixup",
      "never",
      ...(verbose ? ["-v"] : ["--no-warnings"]),
      ...(qjsBin ? ["--js-runtimes", `quickjs:${qjsBin}`] : []),
      ...(ffmpegLocation ? ["--ffmpeg-location", ffmpegLocation] : []),
      ...(proxyUrl ? ["--proxy", proxyUrl] : []),
      "-o",
      tempPath,
      url,
    ];

    const bin = resolveYtDlpBin();
    const safeArgs = proxyUrl
      ? args.map((a) => (a === proxyUrl ? redactProxy(a) : a))
      : args;
    console.log(`[yt-dlp] Spawning: ${bin} ${safeArgs.join(" ")}`);

    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderrBuf = "";
    const startMs = Date.now();

    // Stream stdout (yt-dlp progress lines from --newline) and stderr to the
    // log in real time. Without this we lose visibility into long downloads
    // because Vercel only shows logs after the function returns. Keep a
    // buffered copy of stderr too so error reporting still has the full text.
    function makeLineStreamer(label: string) {
      let leftover = "";
      const writeChunk = (chunk: Buffer) => {
        const text = leftover + chunk.toString();
        const lines = text.split("\n");
        leftover = lines.pop() ?? "";
        for (const line of lines) {
          if (line) console.log(`[yt-dlp:${label}] ${line}`);
        }
      };
      const flush = () => {
        if (leftover) {
          console.log(`[yt-dlp:${label}] ${leftover}`);
          leftover = "";
        }
      };
      return { writeChunk, flush };
    }
    const stdout = makeLineStreamer("out");
    const stderr = makeLineStreamer("err");
    proc.stdout.on("data", stdout.writeChunk);
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      stderr.writeChunk(chunk);
    });

    proc.on("error", async (err) => {
      console.error("[yt-dlp] Spawn error:", err);
      await fs.unlink(tempPath).catch(() => {});
      resolve(null);
    });

    proc.on("close", async (code) => {
      // Flush any trailing partial lines (yt-dlp's final messages often
      // don't end with \n; without this they'd vanish before we log them).
      stdout.flush();
      stderr.flush();
      console.log(`[yt-dlp] Process closed with exit code: ${code}`);
      if (code !== 0) {
        console.error(
          `[yt-dlp] Exited with code ${code}. stderr:\n${stderrBuf}`
        );
        await fs.unlink(tempPath).catch(() => {});
        resolve(null);
        return;
      }
      try {
        const stat = await fs.stat(tempPath);
        const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
        const elapsedMs = Date.now() - startMs;
        console.log(
          `[yt-dlp] Downloaded ${sizeMB}MB in ${(elapsedMs / 1000).toFixed(1)}s`
        );
        // NB: don't unlink — the caller streams from this file and is
        // responsible for cleanup.
        resolve({ filePath: tempPath, sizeBytes: stat.size, duration: 0 });
      } catch (err) {
        console.error("[yt-dlp] Failed to stat tempfile:", err);
        await fs.unlink(tempPath).catch(() => {});
        resolve(null);
      }
    });
  });
}
