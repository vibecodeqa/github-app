/**
 * GitHub webhook handler — receives push and pull_request events.
 *
 * On pull_request (opened/synchronize):
 *   1. Check repo settings for trigger config
 *   2. Post a "scanning..." comment
 *   3. Trigger GH Actions workflow
 *   4. Quality gate: post commit status based on score
 *
 * On push (to default branch):
 *   1. Check repo settings for onPush trigger
 *   2. Trigger scan workflow
 */

import type { Env } from "./index.js";
import { createAppJWT, getInstallationToken } from "./github.js";
import { getRepoSettings } from "./settings.js";

interface WebhookPayload {
	action?: string;
	ref?: string;
	after?: string;
	pull_request?: {
		number: number;
		head: { sha: string; ref: string };
		base: { ref: string };
	};
	repository?: {
		full_name: string;
		owner: { login: string };
		name: string;
		default_branch?: string;
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
		const repo = payload.repository?.full_name;
		if (repo) {
			const settings = await getRepoSettings(repo, env);
			if (!settings.triggers.onPr) {
				return Response.json({ ok: true, action: "pr_trigger_disabled" });
			}
		}
		await handlePullRequest(payload, env);
		return Response.json({ ok: true, action: "pr_scan_triggered" });
	}

	if (event === "push" && payload.repository) {
		const repo = payload.repository.full_name;
		const defaultBranch = payload.repository.default_branch || "main";
		const ref = payload.ref;

		// Only act on pushes to the default branch
		if (ref === `refs/heads/${defaultBranch}`) {
			const settings = await getRepoSettings(repo, env);
			if (settings.triggers.onPush) {
				await handlePush(payload, env);
				return Response.json({ ok: true, action: "push_scan_triggered" });
			}
		}
		return Response.json({ ok: true, action: "push_ignored" });
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

	// Try to trigger the vibecodeqa workflow if it exists
	const dispatchRes = await fetch(
		`https://api.github.com/repos/${repo.full_name}/actions/workflows/vibecodeqa.yml/dispatches`,
		{
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ ref: pr.head.ref }),
		},
	);

	if (dispatchRes.ok) {
		// Workflow dispatched — update comment
		await fetch(`https://api.github.com/repos/${repo.full_name}/issues/comments/${comment.id}`, {
			method: "PATCH",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({
				body: `## VibeCode QA\n\nScanning PR #${pr.number} (\`${pr.head.ref}\` \u2192 \`${pr.base.ref}\`)...\n\n\u23f3 Workflow triggered — results will appear when the scan completes.\n\n[View dashboard](https://app.vibecodeqa.online)`,
			}),
		});
	} else {
		// No workflow found — post setup instructions
		await fetch(`https://api.github.com/repos/${repo.full_name}/issues/comments/${comment.id}`, {
			method: "PATCH",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({
				body: [
					"## VibeCode QA",
					"",
					`PR #${pr.number} (\`${pr.head.ref}\` \u2192 \`${pr.base.ref}\`)`,
					"",
					"No workflow found. Add this to enable automatic PR scanning:",
					"```yaml",
					"# .github/workflows/vibecodeqa.yml",
					"name: VibeCode QA",
					"on: [pull_request]",
					"permissions: { contents: read }",
					"jobs:",
					"  scan:",
					"    runs-on: ubuntu-latest",
					"    steps:",
					"      - uses: actions/checkout@v4",
					"      - run: npx @vibecodeqa/cli --ci --fail-under 70 --sarif --upload",
					"        env:",
					"          VCQA_TOKEN: ${{ secrets.VCQA_TOKEN }}",
					"      - uses: github/codeql-action/upload-sarif@v3",
					"        if: always()",
					"        with:",
					"          sarif_file: .vibe-check/report.sarif",
					"```",
					"",
					"[Setup guide](https://vibecodeqa.online) | [Dashboard](https://app.vibecodeqa.online)",
				].join("\n"),
			}),
		});
	}
}

async function handlePush(payload: WebhookPayload, env: Env): Promise<void> {
	const repo = payload.repository!;
	const installationId = payload.installation?.id;
	if (!installationId) return;

	const token = await getInstallationToken(installationId, env);
	if (!token) return;

	// Trigger the vibecodeqa workflow
	await fetch(`https://api.github.com/repos/${repo.full_name}/actions/workflows/vibecodeqa.yml/dispatches`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"User-Agent": "VibeCodeQA-App",
			Accept: "application/vnd.github+json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ ref: payload.ref?.replace("refs/heads/", "") || "main" }),
	}).catch(() => {});
}

/**
 * Post a commit status (quality gate) for a given SHA.
 * Called after a report is uploaded for a repo with quality gates enabled.
 */
export async function postQualityGateStatus(
	repo: string,
	sha: string,
	score: number,
	env: Env,
): Promise<void> {
	const settings = await getRepoSettings(repo, env);
	if (!settings.qualityGate.enabled) return;

	const passed = score >= settings.qualityGate.minScore;

	// Need an installation token — find installation for the repo owner
	const [owner] = repo.split("/");
	const jwt = await createAppJWT(env);

	const installRes = await fetch(`https://api.github.com/orgs/${owner}/installation`, {
		headers: { Authorization: `Bearer ${jwt}`, "User-Agent": "VibeCodeQA-App", Accept: "application/vnd.github+json" },
	});
	if (!installRes.ok) return;

	const installation = (await installRes.json()) as { id: number };
	const token = await getInstallationToken(installation.id, env);
	if (!token) return;

	await fetch(`https://api.github.com/repos/${repo}/statuses/${sha}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"User-Agent": "VibeCodeQA-App",
			Accept: "application/vnd.github+json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			state: passed ? "success" : "failure",
			description: passed
				? `Score ${score}/100 (min: ${settings.qualityGate.minScore})`
				: `Score ${score}/100 — below minimum ${settings.qualityGate.minScore}`,
			context: "VibeCode QA / Quality Gate",
			target_url: "https://app.vibecodeqa.online",
		}),
	}).catch(() => {});
}

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	const expected = `sha256=${Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
	// Constant-time comparison to prevent timing attacks
	if (signature.length !== expected.length) return false;
	const a = encoder.encode(signature);
	const b = encoder.encode(expected);
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a[i] ^ b[i];
	}
	return result === 0;
}
