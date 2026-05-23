/**
 * yt-dlp wrapper — downloads a YouTube video as a single mp4 buffer.
 *
 * Runtime:
 *   - On Vercel: invokes the bundled Linux x86_64 yt-dlp at `bin/yt-dlp_linux`
 *     and the bundled QuickJS at `bin/qjs` (both shipped via
 *     `functions.includeFiles` in vercel.json).
 *   - Locally: shells out to a system `yt-dlp` on PATH (`brew install yt-dlp`).
 *
 * To force the bundled binaries in a non-Vercel environment, set
 * YT_DLP_BIN and/or YT_DLP_QJS_BIN to absolute paths.
 *
 * QuickJS is bundled (2MB) to satisfy yt-dlp's JS-runtime requirement for
 * the new YouTube extractor — without one, yt-dlp warns "No supported
 * JavaScript runtime could be found" and falls back to incomplete extraction.
 * Deno would also work but its 110MB binary exceeds GitHub's 100MB limit.
 *
 * Player-client selection: YouTube's default `android_vr` client has been
 * triggering "Sign in to confirm you're not a bot" challenges from cloud IPs
 * (Vercel iad1). We force a non-default rotation that has historically
 * tolerated data-center traffic better. If YT clamps down again, refresh this
 * list (see yt-dlp's youtube extractor source for the current set).
 */
import { spawn } from "child_process";
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
  // Locally, let yt-dlp find a JS runtime on PATH if installed; otherwise skip.
  return null;
}

export async function downloadYouTubeMp4(
  videoId: string
): Promise<{ buffer: Uint8Array; duration: number } | null> {
  const url = `https://youtube.com/watch?v=${videoId}`;

  return new Promise((resolve) => {
    try {
      const qjsBin = resolveQjsBin();
      const args = [
        "-f",
        "bv*[height<=720]+ba/b[height<=720]",
        "--merge-output-format",
        "mp4",
        "--extractor-args",
        "youtube:player_client=tv,ios,mweb,android",
        ...(qjsBin ? ["--js-runtimes", `quickjs:${qjsBin}`] : []),
        "-o",
        "-",
        url,
      ];

      const bin = resolveYtDlpBin();
      console.log(`[yt-dlp] Spawning: ${bin} ${args.join(" ")}`);
      const proc = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      const chunks: Buffer[] = [];
      let stderrBuf = "";
      const startMs = Date.now();

      proc.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      proc.on("error", (err) => {
        console.error("[yt-dlp] Spawn error:", err);
        resolve(null);
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          console.error(`[yt-dlp] Exited with code ${code}. stderr:\n${stderrBuf}`);
          resolve(null);
          return;
        }
        const buffer = new Uint8Array(Buffer.concat(chunks));
        const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
        const elapsedMs = Date.now() - startMs;
        console.log(
          `[yt-dlp] Downloaded ${sizeMB}MB in ${(elapsedMs / 1000).toFixed(1)}s`
        );
        // yt-dlp's stderr typically contains a [download] line — we don't
        // parse a precise duration here; the caller can compute from the
        // mp4 if needed. Return 0 as a sentinel.
        resolve({ buffer, duration: 0 });
      });
    } catch (err) {
      console.error("[yt-dlp] Unexpected error:", err);
      resolve(null);
    }
  });
}
