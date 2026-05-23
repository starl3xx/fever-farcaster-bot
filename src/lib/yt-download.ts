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

function resolveFfmpegBin(): string | null {
  if (process.env.YT_DLP_FFMPEG_BIN) return process.env.YT_DLP_FFMPEG_BIN;
  if (process.env.VERCEL) {
    return path.join(process.cwd(), "bin", "ffmpeg");
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

export async function downloadYouTubeMp4(
  videoId: string
): Promise<{ buffer: Uint8Array; duration: number } | null> {
  const url = `https://youtube.com/watch?v=${videoId}`;
  const tempPath = path.join(os.tmpdir(), `recap-${videoId}-${Date.now()}.mp4`);

  return new Promise((resolve) => {
    const qjsBin = resolveQjsBin();
    const ffmpegBin = resolveFfmpegBin();
    const proxyUrl = resolveProxyUrl();
    // WNBA recap videos on YouTube expose 720p/1080p only as HLS m3u8
    // streams (no direct https). Through the Decodo residential proxy,
    // parallel HLS fragment downloads against one sticky IP trigger
    // Cloudflare 522 retry storms, so we cap at 720p (~149MB) and download
    // serially. The selector still prefers h264+aac so ffmpeg stream-copies.
    // Override the cap with YT_DLP_MAX_HEIGHT (e.g. "1080") to retest 1080p.
    const maxHeight = process.env.YT_DLP_MAX_HEIGHT || "720";
    const formatSelector =
      `bv*[height<=${maxHeight}][vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/` +
      `bv*[height<=${maxHeight}]+ba/` +
      `b[height<=${maxHeight}]`;

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
      "--newline", // progress on new lines so we can stream-parse stderr
      ...(verbose ? ["-v"] : ["--no-warnings"]),
      ...(qjsBin ? ["--js-runtimes", `quickjs:${qjsBin}`] : []),
      ...(ffmpegBin ? ["--ffmpeg-location", ffmpegBin] : []),
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
      return (chunk: Buffer) => {
        const text = leftover + chunk.toString();
        const lines = text.split("\n");
        leftover = lines.pop() ?? "";
        for (const line of lines) {
          if (line) console.log(`[yt-dlp:${label}] ${line}`);
        }
      };
    }
    const stdoutStreamer = makeLineStreamer("out");
    const stderrStreamer = makeLineStreamer("err");
    proc.stdout.on("data", stdoutStreamer);
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      stderrStreamer(chunk);
    });

    proc.on("error", async (err) => {
      console.error("[yt-dlp] Spawn error:", err);
      await fs.unlink(tempPath).catch(() => {});
      resolve(null);
    });

    proc.on("close", async (code) => {
      try {
        if (code !== 0) {
          console.error(
            `[yt-dlp] Exited with code ${code}. stderr:\n${stderrBuf}`
          );
          resolve(null);
          return;
        }
        const buffer = await fs.readFile(tempPath);
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
        const elapsedMs = Date.now() - startMs;
        console.log(
          `[yt-dlp] Downloaded ${sizeMB}MB in ${(elapsedMs / 1000).toFixed(1)}s`
        );
        resolve({ buffer: new Uint8Array(buffer), duration: 0 });
      } catch (err) {
        console.error("[yt-dlp] Failed to read tempfile:", err);
        resolve(null);
      } finally {
        await fs.unlink(tempPath).catch(() => {});
      }
    });
  });
}
