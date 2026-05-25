import { spawn, ChildProcessByStdio } from "child_process";
import { stat } from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { fcFetch } from "./farcaster-auth";

type FfmpegProc = ChildProcessByStdio<null, Readable, Readable>;

function resolveFfmpegBin(): string {
  if (process.env.YT_DLP_FFMPEG_BIN) return process.env.YT_DLP_FFMPEG_BIN;
  if (process.env.VERCEL) return path.join(process.cwd(), "bin", "ffmpeg");
  return "ffmpeg";
}

/**
 * Spawn ffmpeg to remux+transcode the yt-dlp HLS download into a clean
 * Matroska stream on stdout. Returns the child process so the caller can
 * pipe stdout directly into TUS PATCH chunks — we never buffer the full
 * encoded output in memory, which is the only way 1080p fits Vercel's 2GB
 * function ceiling. ultrafast 1080p crf 23 produces 1.5-2GB of output for
 * a 10-min source, and Buffer.concat doubled it during accumulation.
 *
 * Cloudflare Stream rejected stream-copied MPEG-TS-in-MP4 sources (their
 * transcoder 500s) regardless of container, so we re-encode H.264+AAC into
 * MKV. MKV is the only container we tested that Cloudflare accepts AND
 * that ffmpeg can write to a non-seekable pipe.
 */
function spawnRemuxProc(filePath: string): FfmpegProc {
  const ffmpegBin = resolveFfmpegBin();
  // Bitrate-capped encode rather than CRF: Farcaster's prepare-video-upload
  // rejects videos over 1GB ("Video needs to be under 1GB"), and ultrafast
  // crf 23 at 1080p routinely overshoots that. -b:v 4M with -maxrate 5M
  // produces ~300-400MB for a 10-min recap (4 Mbps × 600s = 300MB), close
  // to the source quality and comfortably under the 1GB ceiling.
  const args = [
    "-i",
    filePath,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-b:v",
    "4M",
    "-maxrate",
    "5M",
    "-bufsize",
    "8M",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-f",
    "matroska",
    "pipe:1",
  ];
  console.log(`[ffmpeg] Spawning: ${ffmpegBin} ${args.join(" ")}`);
  return spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Upload the recap to Farcaster's video infrastructure by streaming a fresh
 * ffmpeg transcode directly into the TUS upload — no on-disk or in-memory
 * accumulation of encoded output. Returns the playback URL that renders as
 * native video in Farcaster clients, or null on any pipeline failure.
 *
 * The flow:
 *   1. prepare-video-upload (Farcaster) with a generous size upper bound so
 *      the backend doesn't reject the upload on quota grounds. The TUS
 *      protocol's deferred-length extension is what actually carries the
 *      true byte count once ffmpeg exits.
 *   2. TUS CREATE with `Upload-Defer-Length: 1` (no Upload-Length yet).
 *   3. Stream ffmpeg stdout in 20MB chunks, PATCH each one. On the final
 *      chunk we attach `Upload-Length` so TUS knows the upload is complete.
 *   4. Poll the videoId until Farcaster's pipeline produces an embed URL,
 *      then wait briefly for the embed classifier to index it.
 */
export async function uploadRemuxedToFarcasterStream(
  sourceFilePath: string,
  _slug: string
): Promise<string | null> {
  let proc: FfmpegProc | null = null;

  try {
    const sourceStat = await stat(sourceFilePath);
    const sourceMB = (sourceStat.size / 1024 / 1024).toFixed(1);
    console.log(`[video] Source ${sourceFilePath} (${sourceMB}MB)`);

    // Upper bound for prepare-video-upload. Farcaster rejects >1GB, and our
    // bitrate-capped encode produces ~300-500MB for a 10-min recap. Send
    // 900MB so we're safely under the limit while leaving room for variance.
    const estimatedSize = 900_000_000;

    console.log("[video] Preparing Farcaster video upload...");
    const prepareRes = await fcFetch("/v1/prepare-video-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoSizeBytes: estimatedSize,
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

    proc = spawnRemuxProc(sourceFilePath);
    const ffmpegDone = trackFfmpegExit(proc);

    const totalBytes = await tusUploadStream(uploadUrl, proc.stdout);
    if (totalBytes === null) {
      console.error("[video] Streaming TUS upload failed");
      return null;
    }

    const ffmpegExitCode = await ffmpegDone;
    if (ffmpegExitCode !== 0) {
      console.error(`[video] ffmpeg exited with code ${ffmpegExitCode}`);
      return null;
    }

    const uploadedMB = (totalBytes / 1024 / 1024).toFixed(1);
    console.log(`[video] Upload complete (${uploadedMB}MB), waiting for processing...`);

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
    if (proc && !proc.killed) {
      proc.kill("SIGKILL");
    }
  }
}

/**
 * Resolve to the exit code once ffmpeg closes. Keeps the last 4KB of stderr
 * for diagnostics — full stderr would flood logs with progress chatter.
 */
function trackFfmpegExit(proc: FfmpegProc): Promise<number> {
  let stderrTail = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4096);
  });
  return new Promise((resolve) => {
    proc.on("error", (err) => {
      console.error("[ffmpeg] Spawn error:", err);
      resolve(-1);
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`[ffmpeg] Exited with code ${code}. stderr tail:\n${stderrTail}`);
      }
      resolve(code ?? -1);
    });
  });
}

/**
 * TUS PATCH chunk size. Cloudflare Stream rejects chunked-encoding bodies
 * (502), so each PATCH must be a fixed-size, single-shot body. 20MB
 * balances HTTP overhead against the per-chunk memory footprint.
 */
const TUS_CHUNK_SIZE = 20 * 1024 * 1024;

/**
 * Read exactly `size` bytes from a Readable, returning a Buffer of that
 * length. If the stream ends before `size` bytes accumulate, returns
 * `{ buf, eof: true }` with the partial buffer (possibly empty).
 */
async function readExactly(
  stream: Readable,
  size: number
): Promise<{ buf: Buffer; eof: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let collected = 0;

    const onReadable = () => {
      while (collected < size) {
        const remaining = size - collected;
        const chunk = stream.read(remaining) as Buffer | null;
        if (chunk === null) return; // wait for more
        chunks.push(chunk);
        collected += chunk.length;
      }
      cleanup();
      resolve({ buf: Buffer.concat(chunks, collected), eof: false });
    };
    const onEnd = () => {
      cleanup();
      resolve({ buf: Buffer.concat(chunks, collected), eof: true });
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      stream.off("readable", onReadable);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };

    stream.on("readable", onReadable);
    stream.on("end", onEnd);
    stream.on("error", onError);

    // Kick the read in case data was already buffered before listeners attached.
    onReadable();
  });
}

/**
 * Stream-upload a Readable to Cloudflare Stream via TUS, declaring the
 * total length on the final PATCH (deferred-length extension). Returns the
 * total uploaded byte count, or null on failure.
 */
async function tusUploadStream(
  endpoint: string,
  stream: Readable
): Promise<number | null> {
  try {
    // CREATE with Upload-Defer-Length: 1 — we don't know the encoded size yet.
    const createRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Defer-Length": "1",
        "Upload-Metadata": `filename ${btoa("video.mkv")},filetype ${btoa("video/x-matroska")}`,
      },
    });

    if (createRes.status !== 201 && !createRes.ok) {
      console.error(
        `[video] TUS create failed: ${createRes.status} ${await createRes.text()}`
      );
      return null;
    }

    const location = createRes.headers.get("location");
    if (!location) {
      console.error("[video] TUS create returned no Location header");
      return null;
    }
    console.log(`[video] TUS location: ${location}`);

    let offset = 0;
    let lastProgressLog = Date.now();

    while (true) {
      const { buf, eof } = await readExactly(stream, TUS_CHUNK_SIZE);

      // Three cases:
      //   1. full chunk, more data coming  → normal PATCH
      //   2. full chunk, exactly EOF        → normal PATCH, then EOF PATCH with Upload-Length
      //   3. partial chunk, EOF             → final PATCH carrying Upload-Length
      // We collapse cases 2 and 3 by treating any EOF (including with a full
      // 20MB tail) the same way: send what we have with Upload-Length, then
      // send an empty terminator only if the tail was exactly 20MB AND we
      // haven't already declared length.

      const isFinalDataChunk = eof; // no more bytes will come after this buffer
      const headers: Record<string, string> = {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": String(offset),
        "Content-Type": "application/offset+octet-stream",
        "Content-Length": String(buf.length),
      };
      if (isFinalDataChunk) {
        headers["Upload-Length"] = String(offset + buf.length);
      }

      if (buf.length > 0) {
        const patchRes = await fetch(location, {
          method: "PATCH",
          headers,
          body: buf as unknown as BodyInit,
        });

        if (patchRes.status !== 204 && !patchRes.ok) {
          console.error(
            `[video] TUS PATCH @${offset} (${buf.length}b) failed: ${patchRes.status} ${await patchRes.text()}`
          );
          return null;
        }
        offset += buf.length;

        const now = Date.now();
        if (now - lastProgressLog > 5000 || isFinalDataChunk) {
          const mb = (offset / 1024 / 1024).toFixed(1);
          console.log(`[video] TUS uploaded ${mb}MB`);
          lastProgressLog = now;
        }
      }

      if (isFinalDataChunk) {
        // If buf.length was 0 (stream closed at an exact boundary), we still
        // need to declare the total length to TUS. Send an empty PATCH with
        // Upload-Length so the server knows the upload is complete.
        if (buf.length === 0) {
          const finishRes = await fetch(location, {
            method: "PATCH",
            headers: {
              "Tus-Resumable": "1.0.0",
              "Upload-Offset": String(offset),
              "Upload-Length": String(offset),
              "Content-Type": "application/offset+octet-stream",
              "Content-Length": "0",
            },
          });
          if (finishRes.status !== 204 && !finishRes.ok) {
            console.error(
              `[video] TUS finalize failed: ${finishRes.status} ${await finishRes.text()}`
            );
            return null;
          }
        }
        console.log(`[video] TUS upload succeeded (${offset} bytes total)`);
        return offset;
      }
    }
  } catch (err) {
    console.error("[video] TUS upload error:", err);
    return null;
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

      // Prefer `url` (canonical stream.farcaster.xyz URL the classifier
      // indexes) over `sourceUrl` (raw Cloudflare Stream URL).
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
