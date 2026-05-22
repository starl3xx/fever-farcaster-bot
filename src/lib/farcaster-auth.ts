import { ethers } from "ethers";
import canonicalize from "canonicalize";

const FC_API = "https://api.farcaster.xyz";

let cachedToken: { secret: string; expiresAt: number } | null = null;

/**
 * Get a valid Farcaster Client API session token.
 * Caches the token and refreshes when expired or close to expiry.
 */
async function getSessionToken(): Promise<string> {
  // Reuse cached token if it has >5 min remaining
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5 * 60 * 1000) {
    return cachedToken.secret;
  }

  const mnemonic = process.env.FC_CUSTODY_MNEMONIC;
  if (!mnemonic) {
    throw new Error("Missing FC_CUSTODY_MNEMONIC env var");
  }

  const wallet = ethers.Wallet.fromPhrase(mnemonic);

  // Build the generateToken payload
  const payload = {
    method: "generateToken",
    params: {
      timestamp: Date.now(),
      expiresAt: Date.now() + 86400000 * 30, // 30 days
    },
  };

  // Canonicalize (RFC-8785 sorted keys) and sign with EIP-191
  const serialized = canonicalize(payload) || "";
  const signature = await wallet.signMessage(serialized);
  const sigBase64 = Buffer.from(ethers.getBytes(signature)).toString("base64");
  const cusAuth = `eip191:${sigBase64}`;

  // Exchange for a session token via onboarding-state endpoint
  const res = await fetch(`${FC_API}/v2/onboarding-state`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cusAuth}`,
    },
    body: JSON.stringify({ authRequest: payload }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Farcaster auth failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const token = data?.result?.token;

  if (!token?.secret) {
    throw new Error("No session token in Farcaster auth response");
  }

  cachedToken = { secret: token.secret, expiresAt: token.expiresAt };
  console.log("[fc-auth] Session token obtained, expires:", new Date(token.expiresAt).toISOString());

  return token.secret;
}

/**
 * Make an authenticated request to the Farcaster Client API.
 */
export async function fcFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const secret = await getSessionToken();

  return fetch(`${FC_API}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${secret}`,
    },
  });
}
