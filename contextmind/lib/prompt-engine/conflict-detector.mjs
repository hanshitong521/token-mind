/**
 * Conflict Detector — finds rule statements that argue against each other.
 *
 * Prompt Lab spec Q03 (指令冲突): the optimizer must never silently pick a
 * side in a conflict, only report that the pair conflicts and let the user
 * decide. This detector is heuristic and deterministic; it flags candidate
 * pairs and requires human review (autoApplicable=false).
 */

import { createFinding } from "./rule-engine.mjs";

// Semantic opposites. Deliberately NOT included: a bare `always ↔ never`
// pair. "Always prefer deterministic output" and "Never rewrite user intent"
// are two rules about different subjects; that pair flagged almost every
// real-world rules file as conflicted and maxed the risk score. A conflict
// is a contradiction about the SAME subject, so each pair below is
// subject-specific.
const OPPOSITE_PAIRS = [
	[/(must ask|ask the user|always ask|永远先问|先问用户|先询问)/gi, /(don'?t ask|never ask|不要问|不要询问|直接做|自行决定)/gi],
	[/(read[- ]only|do not modify|只读|不能写|禁止写入)/gi, /(modify|write to|直接修改|写入|覆盖)/gi],
	[/(压缩|精简|减少\s*token|compress)/gi, /(完整保留|不压缩|完整输出|keep (?:it )?full)/gi],
	[/(快速|尽快|move fast|先上线)/gi, /(谨慎|保守|安全第一|先验证|be careful)/gi],
	[/(最小改动|只改|局部改动|minimal change)/gi, /(重构|全面重写|整体重写|rewrite)/gi],
];

/**
 * Scan a manifest's text for conflicting directive pairs. Returns candidate
 * pairs with both clause snippets.
 */
export function findDirectiveConflicts(manifest) {
	const allText = (manifest?.blocks ?? []).map((b) => b.text).join("\n");
	const candidates = [];
	for (const [patA, patB] of OPPOSITE_PAIRS) {
		const hitsA = [...allText.matchAll(patA)].map((m) => ({ match: m[0], index: m.index }));
		const hitsB = [...allText.matchAll(patB)].map((m) => ({ match: m[0], index: m.index }));
		if (hitsA.length === 0 || hitsB.length === 0) continue;
		for (const a of hitsA) {
			for (const b of hitsB) {
				candidates.push({
					clauseA: contextAround(allText, a.index, 70),
					clauseB: contextAround(allText, b.index, 70),
					pattern: `${patA.source} ↔ ${patB.source}`,
				});
			}
		}
	}
	// Trim duplicate pairs (same context window).
	const seen = new Set();
	const out = [];
	for (const c of candidates) {
		const key = `${c.clauseA.slice(0, 30)}|${c.clauseB.slice(0, 30)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(c);
	}
	return out;
}

function contextAround(text, index, radius) {
	const start = Math.max(0, index - radius);
	const end = Math.min(text.length, index + 120);
	return text.slice(start, end).replace(/\s+/g, " ").trim();
}

export const conflictRule = {
	id: "Q03-CONFLICT",
	title: "Conflicting directives",
	category: "QUALITY",
	severity: "HIGH",
	run(manifest) {
		const conflicts = findDirectiveConflicts(manifest);
		return conflicts.map((c) =>
			createFinding({
				ruleId: "Q03-CONFLICT",
				title: "Conflicting directives detected",
				severity: "HIGH",
				category: "QUALITY",
				blockIds: findBlockIdsContaining(manifest, c),
				explanation: `Two directives contradict: "${c.pattern}". The optimizer must not pick a side.`,
				evidence: [
					{ text: c.clauseA },
					{ text: c.clauseB },
				],
				requiresEval: true,
				autoApplicable: false,
			}),
		);
	},
};

function findBlockIdsContaining(manifest, c) {
	const ids = [];
	for (const b of manifest?.blocks ?? []) {
		const t = b.text;
		if (c.clauseA && c.clauseA.length > 10 && t.includes(c.clauseA.slice(0, 30)) ) ids.push(b.id);
		else if (t.includes(c.clauseB?.slice(0, 30) ?? "\u0000")) ids.push(b.id);
	}
	return [...new Set(ids)];
}