/**
 * VibeCode QA GitHub App — Cloudflare Worker
 *
 * Routes:
 *   POST /webhook         — GitHub webhook events (push, pull_request)
 *   GET  /auth/login      — Start GitHub OAuth flow
 *   GET  /auth/callback    — OAuth callback → exchange code for token
 *   GET  /api/repos        — List user's repos with installation status
 *   GET  /health           — Health check
 */

import { handleAuth } from "./auth.js";
import { handleWebhook } from "./webhook.js";

export interface Env {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_WEBHOOK_SECRET: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	APP_URL: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// CORS for app.vibecodeqa.online
		const corsHeaders = {
			"Access-Control-Allow-Origin": env.APP_URL,
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
		};

		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			let response: Response;

			if (path === "/webhook" && request.method === "POST") {
				response = await handleWebhook(request, env);
			} else if (path.startsWith("/auth/")) {
				response = await handleAuth(request, env, url);
			} else if (path === "/api/repos" && request.method === "GET") {
				response = await handleRepos(request, env);
			} else if (path === "/health") {
				response = Response.json({ ok: true, version: "0.1.0" });
			} else {
				response = Response.json({ error: "not found" }, { status: 404 });
			}

			// Add CORS headers to all responses
			for (const [k, v] of Object.entries(corsHeaders)) {
				response.headers.set(k, v);
			}
			return response;
		} catch (err) {
			console.error("Worker error:", err);
			return Response.json({ error: "internal error" }, { status: 500, headers: corsHeaders });
		}
	},
};

async function handleRepos(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
	const token = auth.slice(7);

	// Fetch user's repos from GitHub
	const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
		headers: {
			Authorization: `Bearer ${token}`,
			"User-Agent": "VibeCodeQA-App",
			Accept: "application/vnd.github+json",
		},
	});

	if (!res.ok) {
		return Response.json({ error: "github api error" }, { status: res.status });
	}

	const repos = (await res.json()) as Array<{ full_name: string; name: string; private: boolean; language: string; updated_at: string }>;

	return Response.json(
		repos.map((r) => ({
			fullName: r.full_name,
			name: r.name,
			private: r.private,
			language: r.language,
			updatedAt: r.updated_at,
		})),
	);
}
