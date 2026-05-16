/**
 * GitHub webhook handler — receives push and pull_request events.
 *
 * On pull_request (opened/synchronize):
 *   1. Check out the PR head
 *   2. Post a "scanning..." comment
 *   3. Run analysis (via the report JSON structure)
 *   4. Update comment with results
 *
 * Since CF Workers can't run node/CLI directly, we:
 *   - Parse the repo files via GitHub API (tree endpoint)
 *   - Run a lightweight subset of checks in-worker
 *   - OR trigger a GitHub Actions workflow that runs the full CLI
 *
 * For v0.1, we use the "trigger GH Actions" approach — simpler and full-featured.
 */

import type { Env } from "./index.js";
import { getInstallationToken } from "./github.js";

interface WebhookPayload {
	action?: string;
	pull_request?: {
		number: number;
		head: { sha: string; ref: string };
		base: { ref: string };
	};
	repository?: {
		full_name: string;
		owner: { login: string };
		name: string;
	};
	installation?: { id: number };
}

export async function handleWebhook(request: Request, env: Env): Promise<Response> {
	// Verify webhook signature
	const signature = request.headers.get("x-hub-signature-256");
	const body = await request.text();

	if (!signature || !(await verifySignature(body, signature, env.GITHUB_WEBHOOK_SECRET))) {
		return Response.json({ error: "invalid signature" }, { status: 401 });
	}

	const event = request.headers.get("x-github-event");
	const payload: WebhookPayload = JSON.parse(body);

	if (event === "pull_request" && (payload.action === "opened" || payload.action === "synchronize")) {
		await handlePullRequest(payload, env);
		return Response.json({ ok: true, action: "pr_scan_triggered" });
	}

	// Acknowledge other events
	return Response.json({ ok: true, action: "ignored", event });
}

async function handlePullRequest(payload: WebhookPayload, env: Env): Promise<void> {
	const pr = payload.pull_request!;
	const repo = payload.repository!;
	const installationId = payload.installation?.id;

	if (!installationId) return;

	const token = await getInstallationToken(installationId, env);
	if (!token) return;

	const headers = {
		Authorization: `Bearer ${token}`,
		"User-Agent": "VibeCodeQA-App",
		Accept: "application/vnd.github+json",
	};

	// Post a "scanning" comment
	const commentRes = await fetch(`https://api.github.com/repos/${repo.full_name}/issues/${pr.number}/comments`, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify({
			body: "**VibeCode QA** is scanning this PR... :hourglass_flowing_sand:",
		}),
	});
	const comment = (await commentRes.json()) as { id: number };

	// Trigger the check run via GitHub Actions
	// The repo needs a .github/workflows/vibecodeqa.yml that runs the CLI
	// For now, we post a summary directly by fetching the latest report if available
	// TODO: implement full GH Actions dispatch or in-worker analysis

	// Update comment with instructions for now
	await fetch(`https://api.github.com/repos/${repo.full_name}/issues/comments/${comment.id}`, {
		method: "PATCH",
		headers: { ...headers, "Content-Type": "application/json" },
		body: JSON.stringify({
			body: [
				"## VibeCode QA",
				"",
				`Scanning PR #${pr.number} (\`${pr.head.ref}\` → \`${pr.base.ref}\`)...`,
				"",
				"Add this workflow to your repo to get full scan results:",
				"```yaml",
				"# .github/workflows/vibecodeqa.yml",
				"name: VibeCode QA",
				"on: [pull_request]",
				"jobs:",
				"  scan:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - uses: actions/checkout@v4",
				"      - run: npx @vibecodeqa/cli --ci --sarif",
				"      - uses: github/codeql-action/upload-sarif@v3",
				"        with:",
				"          sarif_file: .vibe-check/report.sarif",
				"```",
				"",
				"[View full setup guide](https://vibecodeqa.online)",
			].join("\n"),
		}),
	});
}

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	const expected = `sha256=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
	return signature === expected;
}
