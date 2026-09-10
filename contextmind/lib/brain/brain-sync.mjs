/**
 * Brain sync on stop (spec §18). Default off; queues for host/script flush.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function brainSyncEnabled(cfg) {
	return Boolean(
		cfg?.brain?.auto_record_on_session_end ||
			cfg?.cache_engine?.brainSync ||
			cfg?.cache_engine?.brainSyncOnStop,
	);
}

export function enqueueBrainSyncStop(projectRoot, cfg, payload) {
	if (!brainSyncEnabled(cfg)) return { skipped: true, reason: "disabled" };
	if (!payload?.summary || !cfg.brain?.project_id) {
		return { skipped: true, reason: "no_summary_or_project" };
	}
	const entry = {
		ts: new Date().toISOString(),
		tool: "record_task_outcome",
		args: {
			project_id: cfg.brain.project_id,
			summary: String(payload.summary).slice(0, 2000),
			importance: payload.importance ?? "medium",
			metadata: { kind: "experience", source: payload.source ?? "cache-engine-stop" },
		},
	};
	const path = join(projectRoot, ".contextmind", "brain-sync-queue.jsonl");
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
		return { skipped: false, queued: true, path };
	} catch {
		return { skipped: true, reason: "write_failed" };
	}
}

export async function maybeBrainSync(cfg, payload) {
	if (!brainSyncEnabled(cfg)) return { skipped: true, reason: "disabled" };
	if (!payload?.summary || !cfg.brain?.project_id) {
		return { skipped: true, reason: "no_summary_or_project" };
	}
	return {
		skipped: false,
		tool: "record_task_outcome",
		args: {
			project_id: cfg.brain.project_id,
			summary: payload.summary,
			importance: payload.importance ?? "medium",
			metadata: { kind: "experience", source: "cache-engine-stop" },
		},
	};
}
