/**
 * Stable cache key dimensions (Ultimate Cache Engine §6 / §14 / §15).
 * Single source for beforeSubmitPrompt + stop + postToolUse.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { loadTaskBundle, taskIdFromLoaded } from "./task-bundle.mjs";
import { buildDependencyFingerprint } from "./cache-engine/dependency-fingerprint.mjs";

export function taskContextHash(projectRoot, cfg) {
	const loaded = loadTaskBundle(projectRoot, cfg);
	const id = taskIdFromLoaded(loaded) ?? "";
	const goal = String(loaded?.bundle?.intent?.goal ?? "").slice(0, 200);
	const allow = JSON.stringify(loaded?.bundle?.spec?.allow_globs ?? []);
	return createHash("sha256").update([id, goal, allow].join("\n"), "utf8").digest("hex").slice(0, 16);
}

export function buildCacheKeyMeta(projectRoot, cfg, overrides = {}) {
	const projectId =
		overrides.project_id ??
		cfg?.brain?.project_id ??
		(projectRoot ? basename(projectRoot) : "");
	return {
		project_id: projectId,
		task_mode: overrides.task_mode ?? "",
		relevant_context_hash: overrides.context_hash ?? taskContextHash(projectRoot, cfg),
		system_prompt_version: overrides.system_prompt_version ?? "cm-stack-1",
		tools_schema_hash: overrides.tools_schema_hash ?? "contextmind-6+brain-5",
		model_family: overrides.model_family ?? "unknown",
	};
}

export function dependencyFingerprint(projectRoot, cfg, extra = {}) {
	return buildDependencyFingerprint(projectRoot, extra);
}

/** Prompts safe to cache as L0 evidence pointers (read/locate, not mutate). */
export function isCacheablePrompt(text) {
	const s = String(text ?? "").trim();
	if (!s || s.length > 2000) return false;
	if (/(?:删除|drop\s+table|rm\s+-rf|force\s+push|改库|上线|commit|push)/i.test(s)) return false;
	if (/(?:定位|在哪|调用链|解释|什么是|how does|where is|orient|contextmind|查找|分析影响)/i.test(s)) return true;
	if (s.length < 480 && /(?:TRedPacket|Feishu|飞书|红包|MonitorException)/i.test(s)) return true;
	return s.length < 280 && !/(?:实现|开发|修复|重构|新增接口)/i.test(s);
}

export function pickBestHandleFromSeen(seen, sessionId) {
	if (!seen?.db) return null;
	try {
		const rows = seen.db
			.prepare(
				`SELECT kind, key, handle_id, hits FROM session_seen
				 WHERE session_id = ? AND handle_id IS NOT NULL AND handle_id != ''
				 ORDER BY hits DESC, first_seen DESC LIMIT 12`,
			)
			.all(sessionId ?? "unknown");
		for (const r of rows) {
			if (r.kind === "orient" || r.kind === "MCP" || String(r.kind).startsWith("context")) {
				return { handle_id: r.handle_id, kind: r.kind, key: r.key };
			}
		}
		return rows[0] ? { handle_id: rows[0].handle_id, kind: rows[0].kind, key: rows[0].key } : null;
	} catch {
		return null;
	}
}

export function seenResourcesForDelta(seen, sessionId, max = 24) {
	if (!seen?.db) return [];
	try {
		return seen.db
			.prepare(
				`SELECT kind, key, handle_id FROM session_seen
				 WHERE session_id = ? ORDER BY first_seen DESC LIMIT ?`,
			)
			.all(sessionId ?? "unknown", max)
			.map((r) => ({ kind: r.kind, key: r.key, handle_id: r.handle_id }));
	} catch {
		return [];
	}
}
