/**
 * GitHub App authentication — JWT + installation tokens.
 */

import type { Env } from "./index.js";

/** Create a JWT for the GitHub App. */
async function createAppJWT(env: Env): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: "RS256", typ: "JWT" };
	const payload = {
		iat: now - 60,
		exp: now + 600,
		iss: env.GITHUB_APP_ID,
	};

	const enc = new TextEncoder();
	const headerB64 = btoa(JSON.stringify(header)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
	const payloadB64 = btoa(JSON.stringify(payload)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
	const data = `${headerB64}.${payloadB64}`;

	// Import PEM private key
	const pem = env.GITHUB_APP_PRIVATE_KEY.replace(/-----BEGIN RSA PRIVATE KEY-----|-----END RSA PRIVATE KEY-----|\n/g, "");
	const binaryKey = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
	const key = await crypto.subtle.importKey("pkcs8", binaryKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);

	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(data));
	const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
		.replace(/=/g, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");

	return `${data}.${sigB64}`;
}

/** Get an installation access token for a specific GitHub App installation. */
export async function getInstallationToken(installationId: number, env: Env): Promise<string | null> {
	const jwt = await createAppJWT(env);

	const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${jwt}`,
			"User-Agent": "VibeCodeQA-App",
			Accept: "application/vnd.github+json",
		},
	});

	if (!res.ok) {
		console.error("Failed to get installation token:", res.status, await res.text());
		return null;
	}

	const data = (await res.json()) as { token: string };
	return data.token;
}
