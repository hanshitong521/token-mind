import { createHash } from "node:crypto";
import { canonicalizePrompt } from "./canonicalizer.mjs";

function sha(parts) {
	return createHash("sha256")
		.update(parts.map((p) => String(p ?? "")).join("\u0001"), "utf8")
		.digest("hex");
}

/**
 * L0 exact request key — never prompt-only (spec §6).
 */
export function buildExactCacheKey({
	normalized_prompt,
	project_id = "",
	task_mode = "",
	relevant_context_hash = "",
	system_prompt_version = "",
	tools_schema_hash = "",
	model_family = "",
}) {
	const norm = canonicalizePrompt(normalized_prompt);
	return sha([
		"exact",
		norm,
		project_id,
		task_mode,
		relevant_context_hash,
		system_prompt_version,
		tools_schema_hash,
		model_family,
	]);
}

export function buildContextCacheKey({ project_id, task_fingerprint, dependency_fp }) {
	return sha(["context", project_id, task_fingerprint, dependency_fp]);
}

export function buildToolCacheKey({ project_id, tool_name, args_hash, dependency_fp = "" }) {
	return sha(["tool", project_id, tool_name, args_hash, dependency_fp]);
}

export function promptHashOnly(text) {
	return sha(["prompt", canonicalizePrompt(text)]);
}
