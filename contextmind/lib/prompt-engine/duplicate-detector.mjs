/**
 * Duplicate Detector — exact / near / schema duplication.
 *
 * Prompt Lab spec: Q04 (重复约束), Q12 (Schema 重复), and the Token analyzer's
 * duplicate cost numbers (spec §13.2) are computed from these primitives.
 *
 * Exact duplicates compare the full canonical text hashes. Near duplicates
 * use a token-set Jaccard over word sequences with a tunable threshold.
 * Schema duplicates compare tool schema blocks pairwise after stripping
 * whitespace + sorting keys.
 */

import { createFinding } from "./rule-engine.mjs";
import { canonicalizeBlockText, canonicalStringify } from "./canonicalizer.mjs";

/**
 * Token bag for similarity. Latin runs stay whole; CJK runs are split into
 * character bigrams. The previous version emitted an entire Chinese sentence as
 * ONE token, which collapsed Chinese similarity to 0 or 1 and made
 * overlap-based comparisons blind to Chinese text.
 */
export function tokenBag(text) {
	const s = String(text ?? "").toLowerCase();
	const out = [];
	for (const w of s.match(/[a-z0-9_]+/g) ?? []) out.push(w);
	for (const run of s.match(/[\u4e00-\u9fff]+/g) ?? []) {
		if (run.length === 1) {
			out.push(run);
			continue;
		}
		for (let i = 0; i < run.length - 1; i += 1) out.push(run.slice(i, i + 2));
	}
	return out;
}

/** Jaccard similarity of two token bags, 0..1. */
export function tokenSimilarity(a, b) {
	const bagA = tokenBag(a);
	const bagB = tokenBag(b);
	if (bagA.length === 0 || bagB.length === 0) return 0;
	const setA = new Set(bagA);
	let common = 0;
	for (const w of bagB) if (setA.has(w)) common += 1;
	return common / (setA.size + new Set(bagB).size - common || 1);
}

/** True when a block text is (near) duplicate of another, threshold default .8 */
export function isNearDuplicate(a, b, threshold = 0.8) {
	const len = Math.max(a.length, b.length);
	if (len === 0) return false;
	const sig = tokenSimilarity(a, b);
	return sig >= threshold && Math.abs(a.length - b.length) / len < 0.5;
}

/**
 * Pairwise exact-duplicate groups. Returns groups of {block, groupId}.
 * Only non-tool blocks participate (tool schemas handled separately).
 */
export function findExactDuplicates(manifest) {
	const byHash = new Map();
	for (const b of manifest?.blocks ?? []) {
		if (b.kind === "tool_schema") continue;
		const key = b.hash;
		if (!byHash.has(key)) byHash.set(key, []);
		byHash.get(key).push(b);
	}
	const groups = [];
	for (const es of byHash.values()) {
		if (es.length > 1) groups.push(es);
	}
	return groups;
}

/** Pairwise near-duplicate pairs (excluding exact dupes). */
export function findNearDuplicates(manifest, threshold = 0.8) {
	const blocks = (manifest?.blocks ?? []).filter((b) => b.kind !== "tool_schema");
	const pairs = [];
	const seenHashes = new Set();
	const textIndex = new Map(); // hash → block
	for (const b of blocks) textIndex.set(b.hash, b);
	for (let i = 0; i < blocks.length; i += 1) {
		const a = blocks[i];
		for (let j = i + 1; j < blocks.length; j += 1) {
			const b = blocks[j];
			if (a.hash === b.hash) continue;
			if (isNearDuplicate(a.text, b.text, threshold)) {
				const key = [a.id, b.id].sort().join("|");
				if (seenHashes.has(key)) continue;
				seenHashes.add(key);
				pairs.push({ a, b });
			}
		}
	}
	return pairs;
}

/** Tool schema canonical fingerprint (sorted keys, no whitespace). */
export function schemaFingerprint(toolBlock) {
	const sortObj = (v) => {
		if (Array.isArray(v)) return v.map(sortObj);
		if (v && typeof v === "object") {
			const out = {};
			for (const k of Object.keys(v).sort()) out[k] = sortObj(v[k]);
			return out;
		}
		return v;
	};
	try {
		return canonicalStringify(sortObj(JSON.parse(toolBlock.text)));
	} catch {
		return canonicalizeBlockText(toolBlock.text);
	}
}

/** Find tool schemas that are duplicated (same name+parameters). */
export function findSchemaDuplicates(manifest) {
	const schemaBlocks = (manifest?.blocks ?? []).filter((b) => b.kind === "tool_schema");
	const byName = new Map();
	for (const b of schemaBlocks) {
		let name = null;
		try {
			name = JSON.parse(b.text)?.name;
		} catch {
			name = null;
		}
		if (!name) continue;
		const fp = schemaFingerprint(b);
		if (!byName.has(name)) byName.set(name, []);
		byName.get(name).push({ block: b, fp });
	}
	const dups = [];
	for (const [name, entries] of byName) {
		if (entries.length < 2) continue;
		const byFp = new Map();
		for (const e of entries) {
			if (!byFp.has(e.fp)) byFp.set(e.fp, []);
			byFp.get(e.fp).push(e);
		}
		const groups = [...byFp.values()];
		if (groups.length > 1) {
			// Same name, different payloads — the more dangerous case (the model
			// sees two contracts for one tool).
			for (let i = 0; i < groups.length; i += 1) {
				for (const sub of groups.slice(i + 1)) dups.push({ name, groupA: groups[i], groupB: sub });
			}
		} else if (groups[0].length > 1) {
			// Identical payload repeated. The previous implementation only
			// compared *distinct* fingerprints, so an exact repeat produced
			// zero findings — the most common real-world case.
			const g = groups[0];
			dups.push({ name, groupA: [g[0]], groupB: g.slice(1) });
		}
	}
	return dups;
}

/**
 * Rule Q04/Q12 + TOKEN-001. Returns findings for exact duplicates,
 * near duplicates, and schema duplicates.
 */
export const duplicateRules = [
	{
		id: "Q04-DUP-EXACT",
		title: "Exact duplicate content",
		category: "QUALITY",
		severity: "MEDIUM",
		run(manifest) {
			return findExactDuplicates(manifest).map((group) =>
				createFinding({
					ruleId: "Q04-DUP-EXACT",
					title: `Exact duplicate block (${group.length}x) across ${group[0].kind}`,
					severity: "MEDIUM",
					category: "QUALITY",
					blockIds: group.map((b) => b.id),
					explanation: "The same text appears more than once; one copy is redundant.",
					evidence: group.map((b) => ({ blockId: b.id, text: canonicalizeBlockText(b.text).slice(0, 160) })),
					estimatedTokenDelta: -(group.slice(1).reduce((a, b) => a + b.tokenCount.count, 0)),
					requiresEval: false,
					autoApplicable: true,
				}),
			);
		},
	},
	{
		id: "Q04-DUP-NEAR",
		title: "Near-duplicate content",
		category: "QUALITY",
		severity: "LOW",
		run(manifest) {
			return findNearDuplicates(manifest).map(({ a, b }) =>
				createFinding({
					ruleId: "Q04-DUP-NEAR",
					title: `Near-duplicate blocks (similarity ${tokenSimilarity(a.text, b.text).toFixed(2)})`,
					severity: "LOW",
					category: "QUALITY",
					blockIds: [a.id, b.id],
					explanation: "Two blocks carry nearly identical content; likely redundant. Merge confirmed before apply.",
					evidence: [
						{ blockId: a.id, text: canonicalizeBlockText(a.text).slice(0, 120) },
						{ blockId: b.id, text: canonicalizeBlockText(b.text).slice(0, 120) },
					],
					requiresEval: true,
					autoApplicable: false,
				}),
			);
		},
	},
	{
		id: "Q12-SCHEMA-DUP",
		title: "Duplicate tool schema",
		category: "QUALITY",
		severity: "HIGH",
		run(manifest) {
			const dups = findSchemaDuplicates(manifest);
			return dups.map(({ name, groupA, groupB }) =>
				createFinding({
					ruleId: "Q12-SCHEMA-DUP",
					title: `Tool schema "${name}" defined twice`,
					severity: "HIGH",
					category: "QUALITY",
					blockIds: [...groupA, ...groupB].map((e) => e.block.id),
					explanation: "The same tool schema is duplicated; typical when a JSON Schema is also pasted into prompt text.",
					evidence: groupB.map((e) => ({ blockId: e.block.id, text: e.fp.slice(0, 128) })),
					estimatedTokenDelta: -(groupB.reduce((a, e) => a + e.block.tokenCount.count, 0)),
					requiresEval: false,
					autoApplicable: true,
				}),
			);
		},
	},
];

/**
 * TOKEN-001: repeated boilerplate (same line appears N times across blocks).
 */
export const tokenDupRules = [
	{
		id: "TOKEN-001-LINE-REPEAT",
		title: "Repeated boilerplate lines",
		category: "TOKEN",
		severity: "LOW",
		run(manifest) {
			const allText = (manifest?.blocks ?? []).map((b) => b.text).join("\n");
			const lines = allText.split("\n").map((l) => l.trim());
			const count = new Map();
			for (const l of lines) {
				if (l.length < 24) continue;
				count.set(l, (count.get(l) ?? 0) + 1);
			}
			const hurts = [...count.entries()].filter(([, n]) => n >= 3).slice(0, 20);
			return hurts.map(([line, n]) =>
				createFinding({
					ruleId: "TOKEN-001-LINE-REPEAT",
					title: `Boilerplate line repeated ${n}x`,
					severity: "LOW",
					category: "TOKEN",
					blockIds: [],
					explanation: `A ${line.length}-char line appears ${n} times across the prompt.`,
					evidence: [{ text: line.slice(0, 100) }],
					estimatedTokenDelta: -((n - 1) * Math.max(1, Math.ceil(line.length / 4))),
					requiresEval: false,
					autoApplicable: false,
				}),
			);
		},
	},
];