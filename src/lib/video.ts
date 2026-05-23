import { spawn } from "child_process";
import { open, stat } from "fs/promises";
import path from "path";
import { fcFetch } from "./farcaster-auth";

export interface VideoFile {
  filePath: string;
  sizeBytes: number;
}

export interface VideoBuffer {
  buffer: Buffer;
  sizeBytes: number;
}

type VideoSource = VideoFile | VideoBuffer;

function isBufferSource(v: VideoSource): v is VideoBuffer {
  return "buffer" in v;
}

function resolveFfmpegBin(): string {
  if (process.env.YT_DLP_FFMPEG_BIN) return process.env.YT_DLP_FFMPEG_BIN;
  if (process.env.VERCEL) return path.join(process.cwd(), "bin", "ffmpeg");
  return "ffmpeg";
}

/**
 * Stream-copy remux of an MPEG-TS-in-MP4 file (yt-dlp HLS output with
 * --fixup never) into a proper streamable MP4, collected in memory. We
 * can't write to a /tmp temp file because Vercel's /tmp is 512MB and a
 * 1080p source is ~330MB — there's no room for the output.
 *
 * Cloudflare Stream accepts MPEG-TS-in-MP4 uploads but its transcoder
 * produces a broken stream from them. A proper MP4 input transcodes
 * cleanly.
 *
 * Uses fragmented-MP4 muxing (-movflags empty_moov+frag_keyframe) so
 * ffmpeg can write to stdout without needing to seek back to update the
 * moov atom at the end.
 */
export async function remuxToMp4Buffer(filePath: string): Promise<VideoBuffer | null> {
  const ffmpegBin = resolveFfmpegBin();
  const args = [
    "-i",
    filePath,
    "-c",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    "-f",
    "mp4",
    "-movflags",
    "empty_moov+default_base_moof+frag_keyframe",
    "pipe:1",
  ];
  console.log(`[ffmpeg] Spawning: ${ffmpegBin} ${args.join(" ")}`);
  const startMs = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let stderrTail = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      totalSize += chunk.length;
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      // Keep only the last 4KB of stderr to surface the actual error
      // without flooding logs with ffmpeg's normal progress chatter.
      stderrTail = (stderrTail + chunk.toString()).slice(-4096);
    });

    proc.on("error", (err) => {
      console.error("[ffmpeg] Spawn error:", err);
      resolve(null);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`[ffmpeg] Exited with code ${code}. stderr tail:\n${stderrTail}`);
        resolve(null);
        return;
      }
      const buffer = Buffer.concat(chunks, totalSize);
      const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
      const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
      console.log(`[ffmpeg] Remuxed ${sizeMB}MB in ${elapsedSec}s`);
      resolve({ buffer, sizeBytes: buffer.length });
    });
  });
}

/**
 * Upload an mp4 to Farcaster's video infrastructure and return a native
 * playback URL that renders as inline video in Farcaster clients.
 *
 * Flow: prepare upload → TUS upload (streams from disk) → poll until ready
 * → return embed URL.
 *
 * Accepts either a URL string (downloaded via fetch into a tempfile) or a
 * `VideoFile` `{ filePath, sizeBytes }`. Streaming from disk keeps function
 * memory low — a 1080p recap is ~330MB and we have a 2GB budget total
 * including all the upload-side allocations.
 */
export async function uploadToFarcasterStream(
  input: string | VideoSource,
  _slug: string
): Promise<string | null> {
  try {
    // 1. Resolve to a `VideoSource` (file or buffer).
    let videoSource: VideoSource;
    if (typeof input === "string") {
      console.log(`[video] Downloading mp4: ${input}`);
      const dlResponse = await fetch(input);
      if (!dlResponse.ok || !dlResponse.body) {
        console.error(`[video] Failed to fetch mp4: ${dlResponse.status}`);
        return null;
      }
      const bytes = Buffer.from(await dlResponse.arrayBuffer());
      videoSource = { buffer: bytes, sizeBytes: bytes.length };
      console.log(`[video] Downloaded ${(bytes.length / 1024 / 1024).toFixed(1)}MB`);
    } else {
      videoSource = input;
      const sizeMB = (videoSource.sizeBytes / 1024 / 1024).toFixed(1);
      if (isBufferSource(videoSource)) {
        console.log(`[video] Using in-memory buffer (${sizeMB}MB)`);
      } else {
        console.log(`[video] Using file ${videoSource.filePath} (${sizeMB}MB)`);
      }
    }

    // 2. Prepare the upload — get a videoId and TUS upload URL
    console.log("[video] Preparing Farcaster video upload...");
    const prepareRes = await fcFetch("/v1/prepare-video-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoSizeBytes: videoSource.sizeBytes,
        supportsDynamicUpload: true,
      }),
    });

    if (!prepareRes.ok) {
      const errText = await prepareRes.text();
      console.error(`[video] prepare-video-upload failed: ${prepareRes.status} ${errText}`);
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

    // 3. Upload via TUS protocol to the provided upload URL
    const sizeMB = (videoSource.sizeBytes / 1024 / 1024).toFixed(1);
    console.log(`[video] Uploading ${sizeMB}MB via TUS...`);
    const uploaded = await tusUpload(uploadUrl, videoSource);

    if (!uploaded) {
      console.error("[video] TUS upload failed");
      return null;
    }

    console.log("[video] Upload complete, waiting for processing...");

    // 4. Poll until the video is ready
    const embedUrl = await pollForReady(videoId);

    if (embedUrl) {
      // Wait for Farcaster's embed classifier to index the video.
      // Without this delay, POST /v2/casts receives the URL before the
      // classifier knows it's a video, resulting in "No preview found".
      // We verify the URL is fetchable before proceeding.
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
  }
}

/**
 * Wait for the embed URL to become fetchable, then add extra buffer time
 * for Farcaster's embed classifier to index the video. The classifier is
 * a separate service from the CDN — the video can be playable before the
 * classifier registers it, causing "No preview found" on the cast.
 *
 * Strategy: poll HEAD until the CDN serves the video, then wait an
 * additional 30s for the classifier to catch up.
 */
async function waitForEmbedReady(url: string): Promise<boolean> {
  const maxAttempts = 8; // 8 * 5s = 40s for CDN check
  const interval = 5000;
  const classifierBuffer = 30_000; // 30s after CDN is live

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
 * TUS chunk size for PATCH uploads. Cloudflare Stream's TUS endpoint
 * doesn't accept Transfer-Encoding: chunked (which Node's fetch uses for
 * stream bodies), so we read the file in fixed-size chunks and PATCH each
 * one as a separate resumable upload step. 20MB strikes a balance between
 * HTTP overhead (fewer requests) and memory ceiling (per-chunk buffer).
 */
const TUS_CHUNK_SIZE = 20 * 1024 * 1024;

/**
 * Upload video using TUS protocol (resumable upload). Reads the file from
 * disk in 20MB chunks, sending each as a separate PATCH with its own
 * Content-Length. Memory peak is one chunk (~20MB) regardless of file size.
 *
 * Cloudflare Stream's TUS endpoint requires fixed-length PATCH bodies.
 * A single-PATCH streaming body with Transfer-Encoding: chunked (which is
 * what Node fetch does for a Readable body) 502s instantly.
 */
async function tusUpload(endpoint: string, source: VideoSource): Promise<boolean> {
  try {
    // TUS creation request — no Content-Type (causes 415 on Farcaster's proxy)
    const createRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(source.sizeBytes),
        "Upload-Metadata": `filename ${btoa("video.mp4")},filetype ${btoa("video/mp4")}`,
      },
    });

    if (createRes.status !== 201 && !createRes.ok) {
      console.error(`[video] TUS create failed: ${createRes.status} ${await createRes.text()}`);
      return false;
    }

    const location = createRes.headers.get("location");
    if (!location) {
      console.error("[video] TUS create returned no Location header");
      return false;
    }
    console.log(`[video] TUS location: ${location}`);

    // Read a chunk from either a buffer (in-memory remux output) or a file
    // on disk. For buffer sources, subarray() is zero-copy.
    let getChunk: (offset: number, size: number) => Promise<Buffer>;
    let cleanup: () => Promise<void> = async () => {};

    if (isBufferSource(source)) {
      getChunk = async (offset, size) =>
        source.buffer.subarray(offset, offset + size) as Buffer;
    } else {
      const fresh = await stat(source.filePath);
      if (fresh.size !== source.sizeBytes) {
        console.error(
          `[video] File size changed: expected ${source.sizeBytes}, got ${fresh.size}`
        );
        return false;
      }
      const fh = await open(source.filePath, "r");
      const chunkBuf = Buffer.allocUnsafe(TUS_CHUNK_SIZE);
      getChunk = async (offset, size) => {
        const { bytesRead } = await fh.read(chunkBuf, 0, size, offset);
        if (bytesRead !== size) {
          throw new Error(`Short read at ${offset}: expected ${size}, got ${bytesRead}`);
        }
        return chunkBuf.subarray(0, bytesRead);
      };
      cleanup = async () => {
        await fh.close();
      };
    }

    try {
      let offset = 0;
      while (offset < source.sizeBytes) {
        const bytesToRead = Math.min(TUS_CHUNK_SIZE, source.sizeBytes - offset);
        const chunk = await getChunk(offset, bytesToRead);

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
        const pct = ((offset / source.sizeBytes) * 100).toFixed(1);
        console.log(
          `[video] TUS uploaded ${pct}% (${offset}/${source.sizeBytes})`
        );
      }
      console.log("[video] TUS upload succeeded");
      return true;
    } finally {
      await cleanup();
    }
  } catch (err) {
    console.error("[video] TUS upload error:", err);
    return false;
  }
}

/**
 * Poll Farcaster's uploaded-video endpoint until the video is ready.
 * Timeout after ~3 minutes.
 */
async function pollForReady(videoId: string): Promise<string | null> {
  const maxAttempts = 36; // 36 * 5s = 180s
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

      // Check for ready state — prefer `url` (the canonical stream.farcaster.xyz
      // URL that the embed classifier recognizes) over `sourceUrl` (which may be
      // a raw Cloudflare Stream URL the classifier doesn't index).
      if (embed?.url || embed?.sourceUrl) {
        const embedUrl = embed.url || embed.sourceUrl;
        console.log(`[video] Video ready! Embed URL: ${embedUrl}`);
        if (embed.sourceUrl && embed.url && embed.sourceUrl !== embed.url) {
          console.log(`[video] (sourceUrl was: ${embed.sourceUrl})`);
        }
        if (embed.width) console.log(`[video] Dimensions: ${embed.width}x${embed.height}`);
        return embedUrl;
      }

      const state = video?.state || data.result?.state;

      if (state === "error" || state === "failed") {
        console.error("[video] Processing failed:", JSON.stringify(data.result));
        return null;
      }

      console.log(`[video] Processing... (${state || "unknown"}, attempt ${i + 1}/${maxAttempts})`);
    } catch (err) {
      console.error(`[video] Poll error:`, err);
    }
  }

  console.error("[video] Timed out waiting for processing");
  return null;
}
