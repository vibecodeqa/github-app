/**
 * Repo settings helpers — shared between index.ts and webhook.ts.
 */

import type { Env, RepoSettings } from "./index.js";

export function defaultSettings(): RepoSettings {
	return {
		triggers: { onPr: true, onPush: false, scheduled: null },
		qualityGate: { enabled: false, minScore: 70 },
		notifications: [],
	};
}

export async function getRepoSettings(repo: string, env: Env): Promise<RepoSettings> {
	const raw = await env.REPORTS.get(`repo-settings:${repo}`);
	return raw ? JSON.parse(raw) : defaultSettings();
}

export async function sendNotifications(
	repo: string,
	settings: RepoSettings,
	type: "regression" | "scan_complete",
	message: string,
): Promise<void> {
	for (const n of settings.notifications) {
		const shouldFire = (type === "regression" && n.onRegression) || (type === "scan_complete" && n.onScanComplete);
		if (!shouldFire) continue;

		const payload = n.type === "discord"
			? { content: message }
			: { text: message };

		await fetch(n.url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		}).catch(() => {});
	}
}
