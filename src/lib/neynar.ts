import { NeynarAPIClient, Configuration } from "@neynar/nodejs-sdk";
import { CHANNEL_ID } from "./config";
import { fcFetch } from "./farcaster-auth";

let client: NeynarAPIClient | null = null;
let channelParentUrl: string | null = null;

function getClient(): NeynarAPIClient {
  if (!client) {
    const config = new Configuration({
      apiKey: process.env.NEYNAR_API_KEY!,
    });
    client = new NeynarAPIClient(config);
  }
  return client;
}

/**
 * Look up the channel's protocol-level parent_url via Neynar API.
 * Cached after first call since it never changes.
 */
async function getChannelParentUrl(): Promise<string> {
  if (channelParentUrl) return channelParentUrl;

  const response = await getClient().lookupChannel({ id: CHANNEL_ID });
  const url = response.channel.parent_url;
  if (!url) {
    throw new Error(`Channel "${CHANNEL_ID}" has no parent_url`);
  }
  console.log(`[neynar] Resolved channel "${CHANNEL_ID}" parent_url: ${url}`);
  channelParentUrl = url;
  return url;
}

export interface PostResult {
  hash: string;
  error?: undefined;
}

export interface PostError {
  hash?: undefined;
  error: string;
}

interface PostOptions {
  embeds?: { url: string }[];
  idem?: string;
  /** If true, post via Farcaster's API for native video embed support */
  hasVideo?: boolean;
}

/**
 * Post a cast to the configured channel (CHANNEL_ID).
 *
 * When hasVideo is true, posts via the Farcaster Client API (POST /v2/casts)
 * which properly classifies stream.farcaster.xyz URLs as native video embeds.
 * Otherwise uses Neynar SDK.
 */
export async function postToChannel(
  text: string,
  options: PostOptions = {}
): Promise<PostResult | PostError> {
  if (process.env.BOT_ENABLED !== "true") {
    console.log("[neynar] BOT_ENABLED is not true, skipping post");
    console.log("[neynar] Would have posted:", text.substring(0, 100) + "...");
    return { error: "BOT_ENABLED is not true" };
  }

  // Use Farcaster's own API for video casts (Neynar's unfurler can't classify video URLs)
  if (options.hasVideo) {
    return postViaFarcasterApi(text, options);
  }

  try {
    const parentUrl = await getChannelParentUrl();

    const response = await getClient().publishCast({
      signerUuid: process.env.NEYNAR_SIGNER_UUID!,
      text,
      parent: parentUrl,
      channelId: CHANNEL_ID,
      embeds: options.embeds?.map((e) => ({ url: e.url })),
      idem: options.idem,
    });

    console.log("[neynar] Cast published:", response.cast.hash);
    return { hash: response.cast.hash };
  } catch (err: any) {
    const message = err?.response?.data
      ? JSON.stringify(err.response.data)
      : err instanceof Error
        ? err.message
        : String(err);
    console.error("[neynar] Failed to publish cast:", message);
    return { error: message };
  }
}

/**
 * Post a cast via the Farcaster Client API (POST /v2/casts).
 * Required for native video embeds — Farcaster's backend recognizes
 * stream.farcaster.xyz URLs and classifies them as video.
 */
async function postViaFarcasterApi(
  text: string,
  options: PostOptions
): Promise<PostResult | PostError> {
  try {
    const embedUrls = options.embeds?.map((e) => e.url) || [];

    const body: Record<string, unknown> = {
      text,
      embeds: embedUrls,
      channelKey: CHANNEL_ID, // Farcaster API requires exact channel slug
    };

    console.log("[fc-api] Posting cast via Farcaster API with video embed...");
    const res = await fcFetch("/v2/casts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[fc-api] Cast failed: ${res.status} ${errText}`);
      return { error: errText };
    }

    const data = await res.json();
    const hash = data.result?.cast?.hash;

    if (hash) {
      console.log("[fc-api] Cast published:", hash);
      return { hash };
    }

    console.error("[fc-api] No hash in response:", JSON.stringify(data));
    return { error: "No hash in Farcaster API response" };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[fc-api] Failed to publish cast:", message);
    return { error: message };
  }
}
