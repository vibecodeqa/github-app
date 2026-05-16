/**
 * GitHub OAuth flow for app.vibecodeqa.online
 *
 * GET /auth/login    → redirect to GitHub OAuth
 * GET /auth/callback → exchange code for token, redirect to app with token
 */

import type { Env } from "./index.js";

export async function handleAuth(request: Request, env: Env, url: URL): Promise<Response> {
	const path = url.pathname;

	if (path === "/auth/login") {
		const state = crypto.randomUUID();
		const ghUrl = new URL("https://github.com/login/oauth/authorize");
		ghUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
		ghUrl.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
		ghUrl.searchParams.set("scope", "read:user repo");
		ghUrl.searchParams.set("state", state);
		return Response.redirect(ghUrl.toString(), 302);
	}

	if (path === "/auth/callback") {
		const code = url.searchParams.get("code");
		if (!code) {
			return Response.json({ error: "missing code" }, { status: 400 });
		}

		// Exchange code for token
		const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				client_id: env.GITHUB_CLIENT_ID,
				client_secret: env.GITHUB_CLIENT_SECRET,
				code,
			}),
		});

		const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
		if (!tokenData.access_token) {
			return Response.json({ error: tokenData.error || "token exchange failed" }, { status: 400 });
		}

		// Fetch user info
		const userRes = await fetch("https://api.github.com/user", {
			headers: {
				Authorization: `Bearer ${tokenData.access_token}`,
				"User-Agent": "VibeCodeQA-App",
			},
		});
		const user = (await userRes.json()) as { login: string; avatar_url: string };

		// Redirect to app with token + user info in hash (client-side only, never logged)
		const appUrl = new URL(env.APP_URL);
		appUrl.hash = `token=${tokenData.access_token}&login=${encodeURIComponent(user.login)}&avatar=${encodeURIComponent(user.avatar_url)}`;
		return Response.redirect(appUrl.toString(), 302);
	}

	return Response.json({ error: "not found" }, { status: 404 });
}
