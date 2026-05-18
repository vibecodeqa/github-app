/**
 * VibeCode QA GitHub App — Cloudflare Worker
 *
 * Routes:
 *   POST /webhook                          — GitHub webhook events (push, pull_request)
 *   GET  /auth/login                       — Start GitHub OAuth flow
 *   GET  /auth/callback                    — OAuth callback → exchange code for token
 *   GET  /api/repos                        — List user's repos with installation status
 *   GET  /api/orgs                         — List user's GitHub orgs
 *   GET  /api/orgs/:org/repos              — List org repos with latest scores
 *   GET  /api/repos/:owner/:repo/settings  — Get per-repo config
 *   PUT  /api/repos/:owner/:repo/settings  — Save per-repo config
 *   POST /api/repos/:owner/:repo/scan      — Trigger manual scan
 *   POST /api/notifications/test           — Send test notification
 *   GET  /health                           — Health check
 */

import { handleAuth } from "./auth.js";
import { createAppJWT, getInstallationToken } from "./github.js";
import { handleWebhook, postQualityGateStatus } from "./webhook.js";
import { getRepoSettings, sendNotifications, defaultSettings } from "./settings.js";

export interface Env {
	GITHUB_APP_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	GITHUB_WEBHOOK_SECRET: string;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	ANTHROPIC_API_KEY: string;
	APP_URL: string;
	REPORTS: KVNamespace;
}

export interface RepoSettings {
	triggers: { onPr: boolean; onPush: boolean; scheduled: string | null };
	qualityGate: { enabled: boolean; minScore: number };
	notifications: { type: "slack" | "discord"; url: string; onRegression: boolean; onScanComplete: boolean }[];
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// CORS for app.vibecodeqa.online
		const corsHeaders = {
			"Access-Control-Allow-Origin": env.APP_URL,
			"Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
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
			} else if (path === "/api/orgs" && request.method === "GET") {
				response = await handleOrgs(request);
			} else if (path.match(/^\/api\/orgs\/[^/]+\/repos$/) && request.method === "GET") {
				response = await handleOrgRepos(request, env, path);
			} else if (path.match(/^\/api\/repos\/[^/]+\/[^/]+\/settings$/) && request.method === "GET") {
				response = await handleGetRepoSettings(request, env, path);
			} else if (path.match(/^\/api\/repos\/[^/]+\/[^/]+\/settings$/) && request.method === "PUT") {
				response = await handlePutRepoSettings(request, env, path);
			} else if (path.match(/^\/api\/repos\/[^/]+\/[^/]+\/scan$/) && request.method === "POST") {
				response = await handleManualScan(request, env, path);
			} else if (path === "/api/notifications/test" && request.method === "POST") {
				response = await handleTestNotification(request);
			} else if (path === "/api/pro/doc-coherence" && request.method === "POST") {
				response = await handleProDocCoherence(request, env);
			} else if (path === "/api/reports" && request.method === "POST") {
				response = await handleReportUpload(request, env);
			} else if (path.startsWith("/api/reports/") && path.endsWith("/full") && request.method === "GET") {
				response = await handleReportFull(request, env, path);
			} else if (path.startsWith("/api/reports/") && request.method === "GET") {
				response = await handleReportList(request, env, path);
			} else if (path === "/health") {
				response = Response.json({ ok: true, version: "0.3.0" });
			} else {
				response = Response.json({ error: "not found" }, { status: 404 });
			}

			// Add CORS headers (skip redirects — their headers are immutable)
			if (response.status < 300 || response.status >= 400) {
				for (const [k, v] of Object.entries(corsHeaders)) {
					response.headers.set(k, v);
				}
			}
			return response;
		} catch (err) {
			console.error("Worker error:", err);
			return Response.json({ error: "internal error" }, { status: 500, headers: corsHeaders });
		}
	},

	async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
		// Iterate repos with scheduled scans and trigger workflows
		const listed = await env.REPORTS.list({ prefix: "repo-settings:" });
		for (const key of listed.keys) {
			try {
				const raw = await env.REPORTS.get(key.name);
				if (!raw) continue;
				const settings: RepoSettings = JSON.parse(raw);
				if (!settings.triggers.scheduled) continue;

				const repo = key.name.slice("repo-settings:".length);
				const [owner] = repo.split("/");
				await triggerWorkflowDispatch(owner, repo, env);
			} catch {
				// Skip malformed entries
			}
		}
	},
};

// ── Report upload: POST /api/reports ──
// Body: { repo: "owner/name", report: <VibeReport JSON>, sha?: string }
// Stores in KV keyed by repo + timestamp. Keeps last 100 per repo.
// Fires quality gate + regression notifications.

async function handleReportUpload(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	const body = (await request.json()) as { repo?: string; report?: Record<string, unknown>; sha?: string };
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

	// Check for regression (compare to previous)
	const settings = await getRepoSettings(repo, env);
	if (timestamps.length > 0 && report.score != null) {
		const prevTs = timestamps[timestamps.length - 1];
		const prevData = await env.REPORTS.get(`report:${repo}:${prevTs}`);
		if (prevData) {
			const prev = JSON.parse(prevData) as { score?: number; grade?: string };
			const drop = (prev.score ?? 0) - (report.score ?? 0);
			if (drop >= 5) {
				await sendNotifications(
					repo, settings, "regression",
					`*VibeCode QA* | ${repo} score dropped ${drop} pts (${prev.score} → ${report.score})`,
				);
			}
		}
	}

	// Notify on scan complete
	await sendNotifications(
		repo, settings, "scan_complete",
		`*VibeCode QA* | ${repo} scan complete — score: ${report.score}, grade: ${report.grade}`,
	);

	if (!timestamps.includes(ts)) timestamps.push(ts);
	const trimmed = timestamps.slice(-100);
	await env.REPORTS.put(indexKey, JSON.stringify(trimmed));

	// Quality gate — post commit status if SHA provided
	if (body.sha && report.score != null) {
		await postQualityGateStatus(repo, body.sha, report.score, env).catch(() => {});
	}

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
			try {
				const data = await env.REPORTS.get(`report:${repo}:${ts}`);
				if (!data) return null;
				const r = JSON.parse(data) as { score: number; grade: string; timestamp: string; checks?: { issues: unknown[] }[] };
				const issues = r.checks?.reduce((s: number, c) => s + (c.issues?.length || 0), 0) || 0;
				return { score: r.score, grade: r.grade, timestamp: r.timestamp, issues };
			} catch {
				return null;
			}
		}),
	);

	return Response.json({ repo, reports: summaries.filter(Boolean) });
}

// ── Fetch full report: GET /api/reports/:owner/:repo/full ──
// Returns the latest full report JSON for the interactive viewer.

async function handleReportFull(request: Request, env: Env, path: string): Promise<Response> {
	const auth = request.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	// path = /api/reports/owner/repo/full
	const parts = path.replace("/api/reports/", "").replace("/full", "").split("/");
	if (parts.length < 2) {
		return Response.json({ error: "invalid repo path" }, { status: 400 });
	}
	const repo = `${parts[0]}/${parts[1]}`;

	// Get index to find latest timestamp
	const indexKey = `index:${repo}`;
	const existingIndex = await env.REPORTS.get(indexKey);
	if (!existingIndex) {
		return Response.json({ error: "no reports found" }, { status: 404 });
	}

	const timestamps: string[] = JSON.parse(existingIndex);
	const latest = timestamps[timestamps.length - 1];
	const reportData = await env.REPORTS.get(`report:${repo}:${latest}`);
	if (!reportData) {
		return Response.json({ error: "report not found" }, { status: 404 });
	}

	return new Response(reportData, {
		headers: { "Content-Type": "application/json" },
	});
}

// ── GitHub helpers ──

function getToken(request: Request): string | null {
	const auth = request.headers.get("Authorization");
	if (!auth?.startsWith("Bearer ")) return null;
	return auth.slice(7);
}

function ghHeaders(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		"User-Agent": "VibeCodeQA-App",
		Accept: "application/vnd.github+json",
	};
}

function extractRepo(path: string, prefix: string, suffix = ""): string | null {
	// Remove exact prefix and suffix using slice (not replace, to avoid partial matches)
	let stripped = path;
	if (stripped.startsWith(prefix)) stripped = stripped.slice(prefix.length);
	if (suffix && stripped.endsWith(suffix)) stripped = stripped.slice(0, -suffix.length);
	const parts = stripped.split("/");
	if (parts.length < 2) return null;
	return `${parts[0]}/${parts[1]}`;
}

// ── GET /api/orgs — list user's GitHub orgs ──

async function handleOrgs(request: Request): Promise<Response> {
	const token = getToken(request);
	if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });

	const res = await fetch("https://api.github.com/user/orgs?per_page=100", {
		headers: ghHeaders(token),
	});
	if (!res.ok) return Response.json({ error: "github api error" }, { status: res.status });

	const orgs = (await res.json()) as Array<{ login: string; avatar_url: string; description: string | null }>;
	return Response.json(orgs.map((o) => ({ login: o.login, avatar_url: o.avatar_url, description: o.description })));
}

// ── GET /api/orgs/:org/repos — list org repos with latest scores ──

async function handleOrgRepos(request: Request, env: Env, path: string): Promise<Response> {
	const token = getToken(request);
	if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });

	const org = path.slice("/api/orgs/".length, path.lastIndexOf("/repos"));

	const res = await fetch(`https://api.github.com/orgs/${org}/repos?per_page=100&sort=updated`, {
		headers: ghHeaders(token),
	});
	if (!res.ok) return Response.json({ error: "github api error" }, { status: res.status });

	const repos = (await res.json()) as Array<{
		full_name: string; name: string; private: boolean; language: string | null; updated_at: string;
	}>;

	// Enrich with latest scores from KV
	const enriched = await Promise.all(
		repos.map(async (r) => {
			let latestScore: number | null = null;
			let latestGrade: string | null = null;
			try {
				const indexKey = `index:${r.full_name}`;
				const idx = await env.REPORTS.get(indexKey);
				if (idx) {
					const timestamps: string[] = JSON.parse(idx);
					if (timestamps.length > 0) {
						const latest = timestamps[timestamps.length - 1];
						const data = await env.REPORTS.get(`report:${r.full_name}:${latest}`);
						if (data) {
							const parsed = JSON.parse(data) as { score?: number; grade?: string };
							latestScore = parsed.score ?? null;
							latestGrade = parsed.grade ?? null;
						}
				}
			}
			} catch { /* corrupt KV data */ }
			return {
				fullName: r.full_name,
				name: r.name,
				private: r.private,
				language: r.language,
				updatedAt: r.updated_at,
				latestScore,
				latestGrade,
			};
		}),
	);

	return Response.json(enriched);
}

// ── GET /api/repos/:owner/:repo/settings ──

async function handleGetRepoSettings(request: Request, env: Env, path: string): Promise<Response> {
	const token = getToken(request);
	if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });

	const repo = extractRepo(path, "/api/repos/", "/settings");
	if (!repo) return Response.json({ error: "invalid path" }, { status: 400 });

	// Verify user has write access
	const permRes = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders(token) });
	if (!permRes.ok) return Response.json({ error: "repo not found or no access" }, { status: 403 });
	const repoData = (await permRes.json()) as { permissions?: { push?: boolean } };
	if (!repoData.permissions?.push) return Response.json({ error: "write access required" }, { status: 403 });

	const raw = await env.REPORTS.get(`repo-settings:${repo}`);
	const settings: RepoSettings = raw ? JSON.parse(raw) : defaultSettings();

	return Response.json(settings);
}

// ── PUT /api/repos/:owner/:repo/settings ──

async function handlePutRepoSettings(request: Request, env: Env, path: string): Promise<Response> {
	const token = getToken(request);
	if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });

	const repo = extractRepo(path, "/api/repos/", "/settings");
	if (!repo) return Response.json({ error: "invalid path" }, { status: 400 });

	// Verify write access
	const permRes = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders(token) });
	if (!permRes.ok) return Response.json({ error: "repo not found or no access" }, { status: 403 });
	const repoData = (await permRes.json()) as { permissions?: { push?: boolean } };
	if (!repoData.permissions?.push) return Response.json({ error: "write access required" }, { status: 403 });

	const body = (await request.json()) as RepoSettings;

	// Validate notification webhook URLs to prevent SSRF
	const allowedHosts = ["hooks.slack.com", "discord.com", "discordapp.com"];
	for (const n of body.notifications || []) {
		if (!n.url) continue;
		try {
			const u = new URL(n.url);
			if (u.protocol !== "https:" || !allowedHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
				return Response.json({ error: `invalid webhook URL: only Slack/Discord HTTPS webhooks allowed` }, { status: 400 });
			}
		} catch {
			return Response.json({ error: "invalid webhook URL" }, { status: 400 });
		}
	}

	await env.REPORTS.put(`repo-settings:${repo}`, JSON.stringify(body));

	return Response.json({ ok: true });
}

// ── POST /api/repos/:owner/:repo/scan — trigger manual scan ──

async function handleManualScan(request: Request, env: Env, path: string): Promise<Response> {
	const token = getToken(request);
	if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });

	const repo = extractRepo(path, "/api/repos/", "/scan");
	if (!repo) return Response.json({ error: "invalid path" }, { status: 400 });

	// Trigger workflow_dispatch via user token
	const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/vibecodeqa.yml/dispatches`, {
		method: "POST",
		headers: { ...ghHeaders(token), "Content-Type": "application/json" },
		body: JSON.stringify({ ref: "main" }),
	});

	if (!res.ok) {
		const text = await res.text();
		return Response.json({ error: "failed to trigger scan", details: text }, { status: res.status });
	}

	return Response.json({ ok: true, action: "workflow_dispatched" });
}

// ── POST /api/notifications/test — send test notification ──

async function handleTestNotification(request: Request): Promise<Response> {
	const token = getToken(request);
	if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });

	const body = (await request.json()) as { type: "slack" | "discord"; url: string };
	if (!body.url) return Response.json({ error: "missing webhook url" }, { status: 400 });

	// Validate webhook URL — only allow known webhook domains to prevent SSRF
	let parsed: URL;
	try { parsed = new URL(body.url); } catch { return Response.json({ error: "invalid url" }, { status: 400 }); }
	const allowedHosts = ["hooks.slack.com", "discord.com", "discordapp.com"];
	if (!allowedHosts.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) {
		return Response.json({ error: "only Slack and Discord webhook URLs are allowed" }, { status: 400 });
	}
	if (parsed.protocol !== "https:") {
		return Response.json({ error: "webhook URL must use HTTPS" }, { status: 400 });
	}

	const message = body.type === "discord"
		? { content: "**VibeCode QA** - Test notification. Your webhook is working!" }
		: { text: "*VibeCode QA* - Test notification. Your webhook is working!" };

	const res = await fetch(body.url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(message),
	});

	if (!res.ok) {
		return Response.json({ error: "webhook failed", status: res.status }, { status: 400 });
	}

	return Response.json({ ok: true });
}

// ── POST /api/pro/doc-coherence — LLM-powered doc analysis ──

async function handleProDocCoherence(request: Request, env: Env): Promise<Response> {
	const token = getToken(request);
	if (!token) return Response.json({ error: "unauthorized" }, { status: 401 });
	if (!env.ANTHROPIC_API_KEY) return Response.json({ error: "LLM not configured" }, { status: 503 });

	const body = (await request.json()) as { readme?: string; exports?: { file: string; export: string }[]; docFiles?: string[] };
	if (!body.readme && !body.exports?.length) {
		return Response.json({ findings: [] });
	}
	// Limit input size to prevent abuse
	if ((body.readme?.length || 0) > 10_000) {
		return Response.json({ error: "readme too large (max 10KB)" }, { status: 400 });
	}
	if ((body.exports?.length || 0) > 100) {
		return Response.json({ error: "too many exports (max 100)" }, { status: 400 });
	}

	// Build prompt for Claude — user content in XML tags to prevent injection
	const exportList = (body.exports || []).slice(0, 30).map((e) => `${e.file}: ${e.export}`).join("\n");
	const prompt = `You are a code quality auditor. Analyze the documentation and code exports provided in the <user_content> tags below. Find contradictions: features mentioned in docs but not in code, functions documented but not exported, claims that don't match reality.

Return a JSON array of findings. Each finding has: severity ("warning" or "info"), message (what's wrong), file (which doc file). If docs match code, return []. JSON array only, no markdown.

<user_content>
<readme>
${(body.readme || "").slice(0, 4000)}
</readme>
<exports>
${exportList}
</exports>
<doc_files>${(body.docFiles || []).join(", ")}</doc_files>
</user_content>`;

	try {
		const res = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": env.ANTHROPIC_API_KEY,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 1024,
				messages: [{ role: "user", content: prompt }],
			}),
		});

		if (!res.ok) {
			return Response.json({ findings: [], error: "LLM request failed" });
		}

		const data = (await res.json()) as { content: { text: string }[] };
		const text = data.content?.[0]?.text || "[]";
		const findings = JSON.parse(text);
		return Response.json({ findings: Array.isArray(findings) ? findings : [] });
	} catch {
		return Response.json({ findings: [] });
	}
}

async function triggerWorkflowDispatch(owner: string, repo: string, env: Env): Promise<void> {
	// Find installation ID for the owner
	const jwt = await createAppJWT(env);
	const res = await fetch(`https://api.github.com/orgs/${owner}/installation`, {
		headers: {
			Authorization: `Bearer ${jwt}`,
			"User-Agent": "VibeCodeQA-App",
			Accept: "application/vnd.github+json",
		},
	});
	if (!res.ok) return;

	const installation = (await res.json()) as { id: number };
	const token = await getInstallationToken(installation.id, env);
	if (!token) return;

	await fetch(`https://api.github.com/repos/${repo}/actions/workflows/vibecodeqa.yml/dispatches`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"User-Agent": "VibeCodeQA-App",
			Accept: "application/vnd.github+json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ ref: "main" }),
	}).catch(() => {});
}

// ── Existing handlers ──

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
