/**
 * Conservative Rewrite adapter (spec §14 Mode C / Step 10; ADR-0013).
 *
 * P10 requires an Eval before any SEMANTIC_REWRITE is applied. This module is
 * the *adapter contract*: an adapter turns near-duplicate / mergeable block
 * pairs into concrete, reversible SEMANTIC patch operations WITHOUT an LLM —
 * the builtin adapter only merges blocks that are near-identical rule
 * sections, so the "rewrite" is a mechanical consolidation, not a paraphrase.
 *
 * Every produced op carries risk SEMANTIC_REWRITE and must pass through the
 * Eval gate before a human applies it (the lab UI never auto-applies).
 *
 * LLM-backed adapters can implement the same surface later (Step 10 "LLM
 * rewrite") without touching the optimizer: they return the same op shape.
 */

import { OP, createPatch, blockListRoot } from "./patch.mjs";
import { tokenSimilarity } from "./duplicate-detector.mjs";

/** Similarity floor for a mechanical merge (conservative by design). */
export const MERGE_SIMILARITY_FLOOR = 0.72;

/**
 * Build Mode-C semantic candidates for a manifest: near-duplicate block pairs
 * that are (a) similar enough to merge mechanically, (b) NOT exact duplicates
 * (those belong to Mode-B dedup), (c) not DO_NOT_TOUCH.
 *
 * Returns candidates shaped for the patch vocabulary:
 *   { candidateId, ruleId, severity, title, why, blockRefs,
 *     ops: [ MERGE_BLOCKS ], risk: "SEMANTIC_REWRITE",
 *     tokenDelta, requiresEval: true }
 */
export function conservativeRewriteCandidates(manifest, { similarityFloor = MERGE_SIMILARITY_FLOOR } = {}) {
	const blocks = manifest?.blocks ?? [];
	const out = [];

	const seen = new Set();
	const occOfAt = (idx) => {
		let n = 0;
		for (let k = 0; k < idx; k += 1) if (blocks[k].id === blocks[idx].id) n += 1;
		return n;
	};
	for (let i = 0; i < blocks.length; i += 1) {
		for (let j = i + 1; j < blocks.length; j += 1) {
			const a = blocks[i];
			const b = blocks[j];
			if (a.mutability === "DO_NOT_TOUCH" || b.mutability === "DO_NOT_TOUCH") continue;
			if (a.kind === "tool_schema" || b.kind === "tool_schema") continue;
			if (a.hash === b.hash) continue; // exact dup → Mode B, not C
			const sim = tokenSimilarity(a.text, b.text);
			if (sim < similarityFloor) continue;
			const key = [a.id, b.id].sort().join("|");
			if (seen.has(key)) continue;
			seen.add(key);

			const occA = occOfAt(i);
			const occB = occOfAt(j);
			const beforeTokens = (a.tokenCount?.count ?? 0) + (b.tokenCount?.count ?? 0);
			// merged text: union of lines, deduped, keep order
			const mergedText = mergeTexts(a.text, b.text);
			const afterTokens = Math.round(mergedText.length / 4);
			const tokenDelta = afterTokens - beforeTokens;

			out.push({
				candidateId: `SEM-${a.id.slice(0, 8)}-${b.id.slice(0, 8)}`,
				ruleId: "Q04-DUP-NEAR",
				severity: "LOW",
				category: "QUALITY",
				title: "Near-duplicate rule sections — conservative merge",
				why: `token similarity ${sim.toFixed(2)} ≥ ${similarityFloor}; merge is mechanical (line-union), semantics preserved by construction`,
				blockRefs: [
					{ blockId: a.id, occurrence: occA },
					{ blockId: b.id, occurrence: occB },
				],
				similarity: +sim.toFixed(3),
				tokenDelta,
				requiresEval: true,
				risk: "SEMANTIC_REWRITE",
				ops: [
					{
						type: OP.MERGE_BLOCKS,
						blockIds: [
							{ blockId: a.id, occurrence: occA },
							{ blockId: b.id, occurrence: occB },
						],
						to: Math.min(i, j),
						block: {
							kind: a.kind,
							role: a.role ?? null,
							stability: a.stability,
							mutability: a.mutability,
							text: mergedText,
						},
						why: `conservative merge (sim ${sim.toFixed(2)})`,
						risk: "SEMANTIC_REWRITE",
					},
				],
			});
		}
	}
	return out;
}

/** Line-union merge: keep every distinct line in first-seen order. */
export function mergeTexts(a, b) {
	const seenLines = new Set();
	const out = [];
	for (const text of [a, b]) {
		for (const line of String(text ?? "").split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || seenLines.has(trimmed)) continue;
			seenLines.add(trimmed);
			out.push(line);
		}
	}
	return out.join("\n");
}

/**
 * Turn accepted candidate ops into a reversible patch against a manifest.
 * `baseBlocks` must be the exact block list the ops were computed against.
 */
export function candidatePatch(manifest, candidate, { evidence = { via: "builtin-conservative-rewrite" } } = {}) {
	const ops = candidate?.ops ?? [];
	if (!Array.isArray(ops) || ops.length === 0) return null;
	return createPatch({
		baseBlocks: manifest?.blocks ?? [],
		operations: ops,
		risk: "SEMANTIC_REWRITE",
		evidence,
		metadata: { candidateId: candidate.candidateId, ruleId: candidate.ruleId },
	});
}

export function rewriteRoot(manifest) {
	return blockListRoot(manifest?.blocks ?? []);
}
