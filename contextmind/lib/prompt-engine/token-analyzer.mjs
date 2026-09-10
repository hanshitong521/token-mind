/**
 * Token Analyzer — per-block breakdown + duplicate/redundancy costs.
 *
 * Prompt Lab spec §13: counts must be labeled estimated (chars/4, the same
 * estimator ContextMind uses everywhere), grouped by manifest layer and
 * split into exact / near / schema / history duplicates so optimization
 * savings are never reported as one magic number.
 *
 * The rules below (exact_duplicate_tokens, repeated_schema_tokens, ...)
 * are pure functions of the manifest; the optimizer reuses them to compute
 * per-patch deltas.
 */

import { countTokens, TOKENIZER_ID } from "../tokens.mjs";
import { segmentOfBlock as layerOfBlock } from "./fingerprint.mjs";
import { tokenSimilarity } from "./duplicate-detector.mjs";

const LAYER = Object.freeze({
	system: "system",
	rules: "rules",
	skills: "skills",
	tools: "tools",
	project: "project",
	dynamic: "dynamic",
	user: "user",
});

/** Map block id → layer name (mirrors fingerprint.segmentOfBlock). */


/** Per-block token records with layer + kind. */
export function blockBreakdown(manifest) {
	return (manifest?.blocks ?? []).map((b) => ({
		id: b.id,
		layer: layerOfBlock(b),
		kind: b.kind,
		role: b.role,
		tokens: b.tokenCount?.count ?? countTokens(b.text ?? ""),
		method: b.tokenCount?.method ?? TOKENIZER_ID,
		estimated: b.tokenCount?.estimated ?? true,
		textPreview: (b.text ?? "").slice(0, 80),
	}));
}

/** Aggregate counts by layer. */
export function tokensByLayer(manifest) {
	const out = {
		system: 0,
		rules: 0,
		skills: 0,
		tools: 0,
		project: 0,
		dynamic: 0,
		user: 0,
		PromptTotal: 0,
	};
	const blocks = manifest?.blocks ?? [];
	for (const b of blocks) {
		const layer = layerOfBlock(b);
		const t = b.tokenCount?.count ?? countTokens(b.text ?? "");
		if (out[layer] === undefined) out[layer] = 0;
		out[layer] += t;
		out.PromptTotal += t;
	}
	for (const k of Object.keys(LAYER)) if (out[k] === undefined) out[k] = 0;
	return out;
}

/**
 * Duplicate-cost report (spec §13.2):
 *  exact_duplicate_tokens     — full text duplicated in ≥2 blocks
 *  near_duplicate_tokens      — near-identical pairs (second copy tokens)
 *  repeated_schema_tokens     — duplicated tool schema payload
 *  repeated_history_tokens    — history blocks that merely echo user content
 *  avoidable_boilerplate_tokens — identifiable boilerplate (persona clichés)
 */
export function duplicateCostReport(manifest) {
	const blocks = manifest?.blocks ?? [];
	let exact = 0;
	let near = 0;
	let schema = 0;
	let history = 0;
	let boilerplate = 0;

	// exact duplicates: group by hash (skip tool schemas)
	const byHash = new Map();
	for (const b of blocks) {
		if (b.kind === "tool_schema") continue;
		if (!byHash.has(b.hash)) byHash.set(b.hash, []);
		byHash.get(b.hash).push(b);
	}
	for (const group of byHash.values()) {
		if (group.length > 1) {
			exact += group.slice(1).reduce((a, b) => a + (b.tokenCount?.count ?? 0), 0);
		}
	}

	// near duplicates
	for (let i = 0; i < blocks.length; i += 1) {
		for (let j = i + 1; j < blocks.length; j += 1) {
			const a = blocks[i];
			const b = blocks[j];
			if (a.kind === "tool_schema" || b.kind === "tool_schema") continue;
			if (a.hash === b.hash) continue;
			const sim = tokenSimilarity(a.text ?? "", b.text ?? "");
			if (sim >= 0.8) near += Math.min(a.tokenCount?.count ?? 0, b.tokenCount?.count ?? 0);
		}
	}

	// schema duplicate via name
	const schemaBlocks = blocks.filter((b) => b.kind === "tool_schema");
	const schemaNames = new Map();
	for (const b of schemaBlocks) {
		let name = null;
		try {
			name = JSON.parse(b.text)?.name;
		} catch {
			name = null;
		}
		if (name == null) continue;
		if (!schemaNames.has(name)) schemaNames.set(name, []);
		schemaNames.get(name).push(b);
	}
	for (const es of schemaNames.values()) {
		if (es.length > 1) schema += es.slice(1).reduce((a, b) => a + (b.tokenCount?.count ?? 0), 0);
	}

	// history echo: tool_result/history blocks that repeat content of a user block
	const userTexts = blocks.filter((b) => b.role === "user" || b.kind === "user_request").map((b) => b.text);
	for (const b of blocks) {
		if (b.kind !== "tool_result" && b.kind !== "history") continue;
		if (userTexts.some((u) => u && u.length > 40 && (b.text ?? "").includes(u.slice(0, 60)))) {
			history += b.tokenCount?.count ?? 0;
		}
	}

	// boilerplate
	const BOILERPLATE = [
		/as an? (?:ai|language model|assistant)/gi,
		/你是[^，。\n]{0,20}(助手|智能体|模型)/gi,
	];
	if (blocks.length > 1) {
		for (const b of blocks) {
			const text = b.text ?? "";
			for (const re of BOILERPLATE) {
				const ms = text.match(re);
				if (ms) {
					boilerplate += countTokens(ms.join(" "));
					break;
				}
			}
		}
	}

	return {
		exact_duplicate_tokens: exact,
		near_duplicate_tokens: near,
		repeated_schema_tokens: schema,
		repeated_history_tokens: history,
		avoidable_boilerplate_tokens: boilerplate,
		total_duplicate_tokens: exact + near + schema + history + boilerplate,
		method: TOKENIZER_ID,
		estimated: true,
	};
}

/** Full token analysis for a manifest. */
export function analyzeTokens(manifest) {
	const byLayer = tokensByLayer(manifest);
	const breakdown = blockBreakdown(manifest);
	const dup = duplicateCostReport(manifest);
	const total = byLayer.PromptTotal;
	return {
		PromptTotal: total,
		method: TOKENIZER_ID,
		estimated: true,
		byLayer,
		breakdown,
		duplicate_cost: dup,
		rules: {
			exact_duplicate_tokens: dup.exact_duplicate_tokens,
			near_duplicate_tokens: dup.near_duplicate_tokens,
			repeated_schema_tokens: dup.repeated_schema_tokens,
			repeated_history_tokens: dup.repeated_history_tokens,
			avoidable_boilerplate_tokens: dup.avoidable_boilerplate_tokens,
		},
	};
}

/**
 * Token Efficiency Score (spec §17.3): start at 100 and subtract wasted
 * share. high count of full duplication is penalized more.
 */
export function tokenEfficiencyScore(tokenAnalysis) {
	if (!tokenAnalysis) return 0;
	const total = tokenAnalysis.PromptTotal;
	if (total === 0) return 100;
	const wasted = tokenAnalysis.total_duplicate_tokens ?? 0;
	const wasteRatio = Math.min(1, wasted / total);
	return Math.max(0, Math.round(100 * (1 - wasteRatio)));
}