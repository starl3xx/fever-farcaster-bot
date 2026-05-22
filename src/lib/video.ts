import { fcFetch } from "./farcaster-auth";

/**
 * Upload an mp4 to Farcaster's video infrastructure and return a native
 * playback URL that renders as inline video in Farcaster clients.
 *
 * Flow: get mp4 bytes (from URL or buffer) → prepare upload → TUS upload to
 * stream.farcaster.xyz → poll until ready → return embed URL.
 *
 * Accepts either a URL string (downloaded via fetch) or a Uint8Array (used
 * directly). The buffer path supports yt-dlp output without an intermediate
 * HTTP hop.
 */
export async function uploadToFarcasterStream(
  input: string | Uint8Array,
  _slug: string
): Promise<string | null> {
  try {
    // 1. Get the mp4 bytes — either fetch from URL or use the provided buffer
    let videoBuffer: Uint8Array;
    if (typeof input === "string") {
      console.log(`[video] Downloading mp4: ${input}`);
      const dlResponse = await fetch(input);
      if (!dlResponse.ok || !dlResponse.body) {
        console.error(`[video] Failed to fetch mp4: ${dlResponse.status}`);
        return null;
      }
      videoBuffer = new Uint8Array(await dlResponse.arrayBuffer());
      const sizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);
      console.log(`[video] Downloaded ${sizeMB}MB`);
    } else {
      videoBuffer = input;
      const sizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);
      console.log(`[video] Using provided buffer: ${sizeMB}MB`);
    }

    // 2. Prepare the upload — get a videoId and TUS upload URL
    console.log("[video] Preparing Farcaster video upload...");
    const prepareRes = await fcFetch("/v1/prepare-video-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoSizeBytes: videoBuffer.length,
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
    const sizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);
    console.log(`[video] Uploading ${sizeMB}MB via TUS...`);
    const uploaded = await tusUpload(uploadUrl, videoBuffer);

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
 * Upload video using TUS protocol (resumable upload).
 * Uses a single creation + data request for simplicity since files are <100MB.
 */
async function tusUpload(endpoint: string, data: Uint8Array): Promise<boolean> {
  try {
    // TUS creation request — no Content-Type (causes 415 on Farcaster's proxy)
    const createRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(data.length),
        "Upload-Metadata": `filename ${btoa("video.mp4")},filetype ${btoa("video/mp4")}`,
      },
    });

    if (createRes.status !== 201 && !createRes.ok) {
      console.error(`[video] TUS create failed: ${createRes.status} ${await createRes.text()}`);
      return false;
    }

    // The Location header contains the Cloudflare Stream URL for the PATCH upload
    const location = createRes.headers.get("location");
    if (!location) {
      console.error("[video] TUS create returned no Location header");
      return false;
    }
    console.log(`[video] TUS location: ${location}`);

    // TUS PATCH — send the full file in one go to the Cloudflare Stream URL
    const patchRes = await fetch(location, {
      method: "PATCH",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": "0",
        "Content-Type": "application/offset+octet-stream",
      },
      body: data as unknown as BodyInit,
    });

    if (patchRes.status === 204 || patchRes.ok) {
      console.log("[video] TUS upload succeeded");
      return true;
    }

    console.error(`[video] TUS PATCH failed: ${patchRes.status} ${await patchRes.text()}`);
    return false;
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
