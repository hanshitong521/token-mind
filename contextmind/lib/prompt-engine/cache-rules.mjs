/**
 * Cache Stability Rules — the part that separates Prompt Lab from a generic
 * prompt checker (spec §11).
 *
 * CACHE-001  early volatility in the stable region (CACHE_PREFIX_BREAKER)
 * CACHE-002  ordering drift (block/tool order must stay stable across rounds)
 * CACHE-003  dynamic content injected inside STATIC rules
 * CACHE-004  duplicated schema inflates prefix cost
 * CACHE-005  tool list ordering instability between snapshots (fired by
 *            cache-analyzer.compare, not per-manifest)
 */

import { createFinding } from "./rule-engine.mjs";
import { analyzeBlockVolatility } from "./volatility.mjs";
import { classifyBlock } from "./segment-classifier.mjs";
import { schemaFingerprint } from "./duplicate-detector.mjs";

/**
 * CACHE-001: scan blocks in the stable region (STATIC/MOSTLY_STATIC by
 * declared stability) for volatile spans. Findings are per block.
 */
export function earlyVolatilityRule(manifest) {
	const findings = [];
	for (const block of manifest?.blocks ?? []) {
		const { stability } = classifyBlock(block);
		if (stability !== "STATIC" && stability !== "MOSTLY_STATIC") continue;
		if (block.kind === "tool_schema") continue;
		const { volatile, spans } = analyzeBlockVolatility(block);
		if (!volatile) continue;
		const first = spans[0];
		findings.push(
			createFinding({
				ruleId: "CACHE-001",
				title: `Cache prefix breaker in ${block.kind} (${first.label})`,
				severity: "HIGH",
				category: "CACHE",
				blockIds: [block.id],
				explanation:
					`Block "${block.kind}" sits in the stable prefix region but contains ` +
					`volatile content ("${first.text.slice(0, 40)}") which invalidates the ` +
					`provider prefix cache downstream. Move dynamic values to the dynamic ` +
					`metadata region (spec §11.1).`,
				evidence: spans.map((s) => ({ text: s.text, label: s.label, range: [s.start, s.end] })),
				estimatedCacheDelta: "PREFIX_BREAKER",
				requiresEval: false,
				autoApplicable: false,
			}),
		);
	}
	return findings;
}

/**
 * CACHE-002: detect unstable orderings inside a single snapshot — blocks with
 * the same kind whose hash repeats (duplicate) already handled; instead check
 * that tool_schema blocks are adjacent to each other and before user content,
 * and that rules aren't interleaved with user requests (a sign of irregular
 * assembly). Real ordering drift across snapshots is a compare() job.
 */
export function orderingDriftRule(manifest) {
	const findings = [];
	const blocks = manifest?.blocks ?? [];
	const toolIdx = blocks.map((b, i) => (b.kind === "tool_schema" ? i : -1)).filter((i) => i >= 0);
	if (toolIdx.length > 0) {
		// tools should be contiguous; a user block between them breaks prefix stability
		for (let i = 1; i < toolIdx.length; i += 1) {
			if (toolIdx[i] !== toolIdx[i - 1] + 1) {
				const gap = blocks.slice(toolIdx[i - 1], toolIdx[i] + 1);
				const interleaved = gap.filter((b) => b.kind !== "tool_schema").map((b) => b.id);
				findings.push(
					createFinding({
						ruleId: "CACHE-002",
						title: "Tool schemas are not contiguous",
						severity: "MEDIUM",
						category: "CACHE",
						blockIds: interleaved,
						explanation:
							"Tool schemas must form a contiguous run in the stable-prefix region; " +
							"non-schema content between them breaks deterministic ordering.",
						evidence: interleaved.map((id) => {
							const b = blocks.find((x) => x.id === id);
							return { blockId: id, kind: b?.kind };
						}),
						estimatedCacheDelta: "ORDER_DRIFT",
						requiresEval: false,
						autoApplicable: false,
					}),
				);
				break;
			}
		}
		// user content before tools
		const userIdx = blocks.findIndex((b) => b.kind === "user_request" || b.role === "user");
		if (userIdx >= 0 && userIdx < toolIdx[0]) {
			findings.push(
				createFinding({
					ruleId: "CACHE-002",
					title: "User request placed before tool schemas",
					severity: "MEDIUM",
					category: "CACHE",
					blockIds: [blocks[userIdx].id],
					explanation:
						"User/instruction content before the tools section forces the stable " +
						"prefix to shift every round; dynamic content should be last (spec §16).",
					estimatedCacheDelta: "ORDER_DRIFT",
					requiresEval: false,
					autoApplicable: false,
				}),
			);
		}
	}
	return findings;
}

/**
 * CACHE-003: DYNAMIC/EPHEMERAL blocks whose content mentions volatile values
 * while sitting inside a STATIC block are already caught by CACHE-001; this
 * catches the structural case: a block whose *declared* class is static but
 * whose content carries a live timestamp/task state.
 */
export function dynamicInStaticRule(manifest) {
	const findings = [];
	for (const block of manifest?.blocks ?? []) {
		const cls = classifyBlock(block);
		if (cls.stability !== "STATIC" && cls.stability !== "MOSTLY_STATIC") continue;
		const { volatile, spans } = analyzeBlockVolatility(block);
		if (volatile && /(task|today|now|current|status|pending)/i.test(block.text.slice(0, 160))) {
			findings.push(
				createFinding({
					ruleId: "CACHE-003",
					title: "Dynamic fact mixed into static rules",
					severity: "MEDIUM",
					category: "CACHE",
					blockIds: [block.id],
					explanation:
						"Rule content references a changing fact (time/task/status). Per " +
						"Q13, dynamic facts must live in the dynamic region, not inside static rules.",
					evidence: spans.slice(0, 4).map((s) => ({ text: s.text, label: s.label })),
					requiresEval: false,
					autoApplicable: false,
				}),
			);
		}
	}
	return findings;
}

/**
 * CACHE-004: schema fingerprint repeated across tool blocks (also surfaces as
 * Q12 but with a cache-side delta estimate).
 */
export function schemaDupCacheRule(manifest) {
	const schemaBlocks = (manifest?.blocks ?? []).filter((b) => b.kind === "tool_schema");
	const fpCount = new Map();
	for (const b of schemaBlocks) fpCount.set(schemaFingerprint(b), (fpCount.get(schemaFingerprint(b)) ?? 0) + 1);
	const findings = [];
	for (const [fp, n] of fpCount) {
		if (n < 2) continue;
		const blocks = schemaBlocks.filter((b) => schemaFingerprint(b) === fp);
		findings.push(
			createFinding({
				ruleId: "CACHE-004",
				title: `Schema repeated ${n}× inflates prefix`,
				severity: "MEDIUM",
				category: "CACHE",
				blockIds: blocks.map((b) => b.id),
				explanation: "Duplicate tool schema is rewritten on every prefix, wasting cache read.",
				estimatedCacheDelta: "SCHEMA_DUP",
				requiresEval: false,
				autoApplicable: true,
			}),
		);
	}
	return findings;
}