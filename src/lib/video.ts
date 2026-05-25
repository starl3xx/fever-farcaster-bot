import { spawn } from "child_process";
import { open, stat, unlink } from "fs/promises";
import path from "path";
import os from "os";
import { fcFetch } from "./farcaster-auth";

function resolveFfmpegBin(): string {
  if (process.env.YT_DLP_FFMPEG_BIN) return process.env.YT_DLP_FFMPEG_BIN;
  if (process.env.VERCEL) return path.join(process.cwd(), "bin", "ffmpeg");
  return "ffmpeg";
}

/**
 * Encode the yt-dlp HLS download into a clean Matroska file on disk.
 *
 * We can't pipe ffmpeg's output straight into TUS PATCH chunks because
 * Cloudflare Stream rejects PATCH bodies that aren't 256 KiB multiples
 * (error 10031). The last chunk is exempt only when `Upload-Length` is
 * declared upfront on the TUS CREATE — which means we need to know the
 * encoded size *before* uploading, which means writing to disk.
 *
 * That puts us inside two budgets at once: Vercel's /tmp is capped at
 * 512 MB, and the 330 MB yt-dlp source plus ~50 MB of PyInstaller cache
 * leave only ~130 MB headroom. To stay safely inside, we downscale to
 * 720p and cap video bitrate at 1 Mbps — produces ~75 MB encoded output.
 * (Farcaster also rejects uploads over 1 GB, so we'd be capping bitrate
 * regardless.) Higher quality requires a streaming yt-dlp → ffmpeg pipe
 * that doesn't land the source on /tmp at all — a worthwhile refactor
 * once the basic pipeline is stable.
 *
 * Cloudflare's transcoder 500s on stream-copied MPEG-TS-in-MP4 sources,
 * so we re-encode H.264+AAC into MKV. MKV's streaming-friendly framing
 * survives a TUS upload, and the encoder's exact-size output means we
 * never need to pad anything.
 */
async function encodeToFile(
  sourcePath: string,
  outPath: string
): Promise<boolean> {
  const ffmpegBin = resolveFfmpegBin();
  const args = [
    // yt-dlp's MPEG-TS-in-MP4 has ragged timestamps; regenerate PTS and
    // ignore source DTS so the encoded output has clean monotonic timing
    // (Cloudflare's transcoder errored on the un-fixed timing).
    "-fflags",
    "+genpts+igndts",
    "-i",
    sourcePath,
    "-vf",
    "scale=-2:720",
    "-c:v",
    "libx264",
    // `veryfast` instead of `ultrafast`: ultrafast skips CABAC, B-frames,
    // and deblocking, producing non-standard H.264 that Cloudflare's HLS
    // transcoder rejected (persistent 424 on the manifest, even with the
    // profile/level hints below). `veryfast` is ~2× slower but produces
    // a fully-conformant stream — ~100s for 10 min of 720p, fits the
    // 600s function budget with room for the upload+poll steps.
    "-preset",
    "veryfast",
    // Force Cloudflare-friendly H.264: Main profile, Level 4.0, yuv420p
    // pixel format. Standard cross-transcoder defaults — without these
    // libx264 will sometimes emit High profile / yuv444p depending on the
    // input, which some downstream pipelines refuse to ingest.
    "-profile:v",
    "main",
    "-level",
    "4.0",
    "-pix_fmt",
    "yuv420p",
    // Force a 2-second keyframe interval (30 fps × 2 = 60). HLS segments
    // need regular keyframes to split cleanly; without this, ultrafast
    // emits sparse keyframes and the segmenter struggles.
    "-g",
    "60",
    "-b:v",
    "1.5M",
    "-maxrate",
    "2M",
    "-bufsize",
    "4M",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-ac",
    "2",
    // Plain MP4 (moov at end). Cloudflare ingests from their backend
    // storage and can seek for moov, so faststart isn't needed and would
    // double peak /tmp use during the post-encode rewrite.
    "-f",
    "mp4",
    "-y",
    outPath,
  ];
  console.log(`[ffmpeg] Spawning: ${ffmpegBin} ${args.join(" ")}`);
  const startMs = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrTail = "";

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096);
    });
    proc.on("error", (err) => {
      console.error("[ffmpeg] Spawn error:", err);
      resolve(false);
    });
    proc.on("close", (code) => {
      const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
      if (code !== 0) {
        console.error(`[ffmpeg] Exited with code ${code} after ${elapsedSec}s. stderr tail:\n${stderrTail}`);
        resolve(false);
        return;
      }
      console.log(`[ffmpeg] Encoded successfully in ${elapsedSec}s`);
      resolve(true);
    });
  });
}

/**
 * Upload the recap to Farcaster's video infrastructure. Returns the
 * playback URL that renders as native video in Farcaster clients, or null
 * on any pipeline failure.
 *
 * Flow:
 *   1. ffmpeg-encode source → /tmp/encoded-*.mkv (bitrate-capped, fits /tmp)
 *   2. prepare-video-upload (Farcaster) — get videoId + TUS endpoint
 *   3. TUS upload from /tmp/encoded-*.mkv in 20 MB chunks
 *   4. Poll until Farcaster's pipeline produces an embed URL
 *   5. Wait briefly for the embed classifier to index it
 */
export async function uploadRemuxedToFarcasterStream(
  sourceFilePath: string,
  _slug: string
): Promise<string | null> {
  const encodedPath = path.join(
    os.tmpdir(),
    `encoded-${Date.now()}.mp4`
  );

  try {
    const encodeOk = await encodeToFile(sourceFilePath, encodedPath);
    if (!encodeOk) return null;

    const encodedStat = await stat(encodedPath);
    const sizeMB = (encodedStat.size / 1024 / 1024).toFixed(1);
    console.log(`[video] Encoded output: ${sizeMB}MB at ${encodedPath}`);

    console.log("[video] Preparing Farcaster video upload...");
    const prepareRes = await fcFetch("/v1/prepare-video-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoSizeBytes: encodedStat.size,
        supportsDynamicUpload: true,
      }),
    });

    if (!prepareRes.ok) {
      console.error(
        `[video] prepare-video-upload failed: ${prepareRes.status} ${await prepareRes.text()}`
      );
      return null;
    }

    const prepareData = await prepareRes.json();
    const result = prepareData.result;
    const videoId: string | undefined = result?.videoId;
    const uploadUrl: string | undefined = result?.uploadUrl;

    if (!videoId || !uploadUrl) {
      console.error("[video] Missing videoId/uploadUrl:", JSON.stringify(prepareData));
      return null;
    }

    console.log(`[video] Video prepared: ${videoId}`);

    const uploaded = await tusUploadFile(uploadUrl, encodedPath, encodedStat.size);
    if (!uploaded) {
      console.error("[video] TUS upload failed");
      return null;
    }

    console.log("[video] Upload complete, waiting for processing...");

    const embedUrl = await pollForReady(videoId);

    if (embedUrl) {
      console.log("[video] Waiting for embed classifier to index...");
      const verified = await waitForEmbedReady(embedUrl);
      if (!verified) {
        console.warn("[video] Embed URL never became fetchable — posting anyway");
      }
    }

    return embedUrl;
  } catch (err) {
    console.error("[video] Farcaster video upload failed:", err);
    return null;
  } finally {
    await unlink(encodedPath).catch(() => {});
  }
}

/**
 * TUS PATCH chunk size. Cloudflare Stream rejects chunked-encoding bodies
 * (502), so each PATCH must be a fixed-length, single-shot body. 20 MB
 * balances HTTP overhead against per-chunk memory footprint and is a
 * multiple of Cloudflare's required 256 KiB alignment. The very last
 * PATCH is allowed to be smaller because Upload-Length is declared on
 * CREATE — Cloudflare knows which chunk is final and exempts it.
 */
const TUS_CHUNK_SIZE = 20 * 1024 * 1024;

/**
 * Upload a file to Cloudflare Stream via TUS. Upload-Length is declared
 * on the CREATE request, so Cloudflare exempts the natural final partial
 * chunk from its 256 KiB-multiple rule.
 */
async function tusUploadFile(
  endpoint: string,
  filePath: string,
  sizeBytes: number
): Promise<boolean> {
  const createRes = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(sizeBytes),
      "Upload-Metadata": `filename ${btoa("video.mp4")},filetype ${btoa("video/mp4")}`,
    },
  });

  if (createRes.status !== 201 && !createRes.ok) {
    console.error(
      `[video] TUS create failed: ${createRes.status} ${await createRes.text()}`
    );
    return false;
  }

  const location = createRes.headers.get("location");
  if (!location) {
    console.error("[video] TUS create returned no Location header");
    return false;
  }
  console.log(`[video] TUS location: ${location}`);

  const fh = await open(filePath, "r");
  const chunkBuf = Buffer.allocUnsafe(TUS_CHUNK_SIZE);

  try {
    let offset = 0;
    while (offset < sizeBytes) {
      const bytesToRead = Math.min(TUS_CHUNK_SIZE, sizeBytes - offset);
      const { bytesRead } = await fh.read(chunkBuf, 0, bytesToRead, offset);
      if (bytesRead !== bytesToRead) {
        console.error(
          `[video] Short read at offset ${offset}: expected ${bytesToRead}, got ${bytesRead}`
        );
        return false;
      }
      const chunk = chunkBuf.subarray(0, bytesRead);

      const patchRes = await fetch(location, {
        method: "PATCH",
        headers: {
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": String(offset),
          "Content-Type": "application/offset+octet-stream",
          "Content-Length": String(bytesToRead),
        },
        body: chunk as unknown as BodyInit,
      });

      if (patchRes.status !== 204 && !patchRes.ok) {
        console.error(
          `[video] TUS PATCH @${offset} (${bytesToRead}b) failed: ${patchRes.status} ${await patchRes.text()}`
        );
        return false;
      }

      offset += bytesToRead;
      const pct = ((offset / sizeBytes) * 100).toFixed(1);
      console.log(`[video] TUS uploaded ${pct}% (${offset}/${sizeBytes})`);
    }
    console.log("[video] TUS upload succeeded");
    return true;
  } finally {
    await fh.close();
  }
}

/**
 * Wait for the embed URL to become fetchable, then add buffer time for
 * Farcaster's embed classifier to index the video. The classifier is a
 * separate service from the CDN — the video can be playable before the
 * classifier registers it, causing "No preview found" on the cast.
 */
async function waitForEmbedReady(url: string): Promise<boolean> {
  const maxAttempts = 8;
  const interval = 5000;
  const classifierBuffer = 30_000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval));

    try {
      const res = await fetch(url, { method: "HEAD" });
      if (res.ok) {
        console.log(`[video] Embed URL live on CDN (attempt ${i + 1}/${maxAttempts})`);
        console.log(`[video] Waiting ${classifierBuffer / 1000}s for embed classifier...`);
        await new Promise((r) => setTimeout(r, classifierBuffer));
        return true;
      }
      console.log(`[video] Embed URL not ready: ${res.status} (attempt ${i + 1}/${maxAttempts})`);
    } catch (err) {
      console.log(`[video] Embed URL fetch error (attempt ${i + 1}/${maxAttempts}):`, err);
    }
  }

  return false;
}

/**
 * Poll Farcaster's uploaded-video endpoint until the video is ready.
 * Timeout after ~3 minutes.
 */
async function pollForReady(videoId: string): Promise<string | null> {
  const maxAttempts = 36;
  const interval = 5000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, interval));

    try {
      const res = await fcFetch(`/v1/uploaded-video?videoId=${videoId}`);

      if (!res.ok) {
        console.error(`[video] Poll failed: ${res.status}`);
        continue;
      }

      const data = await res.json();
      const video = data.result?.video;
      const embed = video?.embed;
      const state = video?.state || data.result?.state;

      if (state === "error" || state === "failed") {
        console.error("[video] Processing failed:", JSON.stringify(data.result));
        return null;
      }

      // Only treat the video as ready when state is explicitly "ready" AND
      // an embed URL exists. Earlier we returned as soon as embed.url was
      // populated, but Farcaster sets that field before Cloudflare's
      // transcode completes — we'd hand back a URL that the CDN 424s on.
      // The transcode-complete signal is `state === "ready"` AND embed
      // dimensions being known.
      if (state === "ready" && (embed?.url || embed?.sourceUrl)) {
        const embedUrl = embed.url || embed.sourceUrl;
        console.log(`[video] Video ready! Embed URL: ${embedUrl}`);
        if (embed.sourceUrl && embed.url && embed.sourceUrl !== embed.url) {
          console.log(`[video] (sourceUrl was: ${embed.sourceUrl})`);
        }
        if (embed.width) console.log(`[video] Dimensions: ${embed.width}x${embed.height}`);
        return embedUrl;
      }

      // Dump the full result block once per attempt so we can see exactly
      // what Farcaster reports during processing — the prior failures
      // surfaced no state info beyond "embed.url present, but unplayable".
      console.log(
        `[video] Processing... (state=${state || "unknown"}, attempt ${i + 1}/${maxAttempts}): ${JSON.stringify(data.result).slice(0, 500)}`
      );
    } catch (err) {
      console.error(`[video] Poll error:`, err);
    }
  }

  console.error("[video] Timed out waiting for processing");
  return null;
}
