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
	REPORTS: KVNamespace;
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
			} else if (path === "/api/reports" && request.method === "POST") {
				response = await handleReportUpload(request, env);
			} else if (path.startsWith("/api/reports/") && request.method === "GET") {
				response = await handleReportList(request, env, path);
			} else if (path === "/health") {
				response = Response.json({ ok: true, version: "0.2.0" });
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

// ── Report upload: POST /api/reports ──
// Body: { repo: "owner/name", report: <VibeReport JSON> }
// Stores in KV keyed by repo + timestamp. Keeps last 30 per repo.

async function handleReportUpload(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	const body = (await request.json()) as { repo?: string; report?: Record<string, unknown> };
	if (!body.repo || !body.report) {
		return Response.json({ error: "missing repo or report" }, { status: 400 });
	}

	const repo = body.repo;
	const report = body.report as { score?: number; grade?: string; timestamp?: string; checks?: unknown[] };
	const ts = report.timestamp || new Date().toISOString();
	const key = `report:${repo}:${ts}`;

	// Store the full report
	await env.REPORTS.put(key, JSON.stringify(report), { expirationTtl: 86400 * 365 }); // 1 year

	// Update the index (list of timestamps for this repo)
	const indexKey = `index:${repo}`;
	const existingIndex = await env.REPORTS.get(indexKey);
	const timestamps: string[] = existingIndex ? JSON.parse(existingIndex) : [];
	timestamps.push(ts);
	// Keep last 100
	const trimmed = timestamps.slice(-100);
	await env.REPORTS.put(indexKey, JSON.stringify(trimmed));

	return Response.json({
		ok: true,
		repo,
		score: report.score,
		grade: report.grade,
		timestamp: ts,
		totalReports: trimmed.length,
	});
}

// ── Report list: GET /api/reports/:owner/:repo ──
// Returns summary of last N reports for trend display.

async function handleReportList(request: Request, env: Env, path: string): Promise<Response> {
	const auth = request.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	// path = /api/reports/owner/repo
	const parts = path.replace("/api/reports/", "").split("/");
	if (parts.length < 2) {
		return Response.json({ error: "invalid repo path" }, { status: 400 });
	}
	const repo = `${parts[0]}/${parts[1]}`;

	const indexKey = `index:${repo}`;
	const existingIndex = await env.REPORTS.get(indexKey);
	if (!existingIndex) {
		return Response.json({ repo, reports: [] });
	}

	const timestamps: string[] = JSON.parse(existingIndex);
	const last30 = timestamps.slice(-30);

	// Fetch summaries (score + grade + timestamp + issue count)
	const summaries = await Promise.all(
		last30.map(async (ts) => {
			const data = await env.REPORTS.get(`report:${repo}:${ts}`);
			if (!data) return null;
			const r = JSON.parse(data) as { score: number; grade: string; timestamp: string; checks?: { issues: unknown[] }[] };
			const issues = r.checks?.reduce((s: number, c) => s + (c.issues?.length || 0), 0) || 0;
			return { score: r.score, grade: r.grade, timestamp: r.timestamp, issues };
		}),
	);

	return Response.json({ repo, reports: summaries.filter(Boolean) });
}

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
