/**
 * Stable Layout Engine (spec §16; round-3 instance-level layer).
 *
 * The segment classifier already owns the deterministic mapping tables
 * (KIND_STABILITY / KIND_SLOT / LAYOUT_SLOTS). This module adds the
 * INSTANCE-level view the classifier does not provide:
 *
 *   1. a per-instance lane report (every block occurrence, its §16 slot,
 *      effective stability and mutability);
 *   2. the cache "frontier" — the first DYNAMIC/EPHEMERAL instance (the same
 *      boundary analyzeCacheStability computes); stable content found AFTER
 *      that boundary erodes the stable prefix;
 *   3. MOVE candidates for the ONLY provably-safe case: an instance the
 *      parser marks mutability === "SAFE_REORDER" (project_contract /
 *      repo_map / wiki that carry no volatile content) sitting after the
 *      frontier. Those are surfaced as suggestions with a concrete
 *      (blockId, occurrence, to) op — they are NEVER auto-applied (layout
 *      changes are SEMANTIC_REWRITE-grade; §33 single-accept only).
 *
 * Everything else after the frontier is reported as manual / Eval-grade:
 *  - SAFE_COMPACT instances (rule/instruction/example) keep order semantics
 *    — moving them can change behavior;
 *  - DO_NOT_TOUCH instances (volatile content, tool_result, history, the
 *    user request, schemas…) cannot be repositioned by the optimizer at all.
 *
 * Every function here is pure and deterministic; inputs are never mutated.
 */

import { classifyBlock, LAYOUT_SLOTS } from "./segment-classifier.mjs";
import { analyzeCacheStability } from "./cache-analyzer.mjs";

/** Suggested-before-frontier MOVE candidates (single-accept, never auto). */
export const LAYOUT_RULE_ID = "LAYOUT-001";
export const LAYOUT_USER_LAST_RULE_ID = "LAYOUT-002";

const isDynamicLike = (effective) => effective === "DYNAMIC" || effective === "EPHEMERAL";

/** Per-instance view: [{ block, index, occurrence, ref }]. */
function instancesOf(blocks) {
	const counts = new Map();
	const out = [];
	for (let i = 0; i < (blocks ?? []).length; i += 1) {
		const b = blocks[i];
		const occ = counts.get(b.id) ?? 0;
		counts.set(b.id, occ + 1);
		out.push({ block: b, index: i, occurrence: occ, ref: `${b.id}#${occ}` });
	}
	return out;
}

/** Rank of a §16 lane label ("L0"…"L7"); unknown → L5 (deep fallback). */
function laneRankOf(slotLabel) {
	const rank = LAYOUT_SLOTS.findIndex((s) => s.label.startsWith(slotLabel));
	return rank < 0 ? 5 : rank;
}

/**
 * Full instance-level layout report (spec §16 logical layout).
 *
 * Returns (all deterministic):
 *  lanes        aggregated per §16 lane: block/token counts + refs
 *  order        every instance with kind / lane / stability / mutability
 *  frontier     { blockId, index, stablePrefixTokens, ratio } or null
 *  violations   frontier violations + user-request-last violations
 *  summary      { blocks, totalTokens, movableAfterFrontier, manualAfterFrontier }
 */
export function layoutReport(manifest) {
	const blocks = manifest?.blocks ?? [];
	const instances = instancesOf(blocks);
	const cache = analyzeCacheStability(manifest);

	const lanes = LAYOUT_SLOTS.map((s, rank) => ({
		lane: s.label.slice(0, 2),
		label: s.label,
		rank,
		stability: s.stability,
		blockCount: 0,
		tokenCount: 0,
		refs: [],
	}));

	const order = instances.map((inst) => {
		const cls = classifyBlock(inst.block);
		const lane = cls.slot ?? "L5";
		const rank = laneRankOf(lane);
		const movable = inst.block?.mutability === "SAFE_REORDER";
		const entry = {
			index: inst.index,
			blockId: inst.block.id,
			occurrence: inst.occurrence,
			ref: inst.ref,
			kind: inst.block.kind,
			lane,
			label: LAYOUT_SLOTS[rank]?.label ?? lane,
			stability: cls.stability,
			effective: cls.effective,
			mutability: inst.block?.mutability ?? "DO_NOT_TOUCH",
			movable,
			tokens: inst.block?.tokenCount?.count ?? 0,
		};
		lanes[rank].blockCount += 1;
		lanes[rank].tokenCount += entry.tokens;
		lanes[rank].refs.push(inst.ref);
		return entry;
	});

	let frontier = null;
	if (cache?.firstDynamicBlock) {
		const hit = order.find((o) => o.blockId === cache.firstDynamicBlock);
		if (hit) {
			frontier = {
				blockId: cache.firstDynamicBlock,
				index: hit.index,
				kind: hit.kind,
				stablePrefixTokens: cache.stablePrefixTokens ?? 0,
				ratio: cache.stablePrefixRatio ?? 0,
			};
		}
	}

	// ── violations ─────────────────────────────────────────────────────────
	const violations = [];
	const movableAfterFrontier = [];
	const manualAfterFrontier = [];
	if (frontier) {
		for (const inst of order) {
			if (inst.index <= frontier.index) continue;
			if (isDynamicLike(inst.effective)) continue; // belongs after frontier
			const rec = {
				ruleId: LAYOUT_RULE_ID,
				title: "Stable content sits after the dynamic frontier",
				severity: "MEDIUM",
				category: "CACHE",
				blockId: inst.blockId,
				occurrence: inst.occurrence,
				ref: inst.ref,
				kind: inst.kind,
				mutability: inst.mutability,
				movable: inst.movable,
				why:
					inst.movable
						? "SAFE_REORDER instance placed after the first dynamic block shrinks the stable prefix; moving it before the frontier is a cache-safe layout change"
						: inst.mutability === "SAFE_COMPACT"
							? "rule/instruction order is sequence-sensitive; repositioning needs Eval (P10), never auto-apply"
							: "DO_NOT_TOUCH instance cannot be repositioned by the optimizer; move it in your own assembly (§16: Prompt Lab only controls user-owned assets)",
			};
			violations.push(rec);
			if (inst.movable) movableAfterFrontier.push({ entry: inst, violation: rec });
			else manualAfterFrontier.push(rec);
		}
	}

	// §16 L7: the current user request must be the last block.
	const lastUser = order.filter((o) => o.kind === "user_request").at(-1);
	if (lastUser && lastUser.index !== order.length - 1) {
		violations.push({
			ruleId: LAYOUT_USER_LAST_RULE_ID,
			title: "Current user request is not last",
			severity: "HIGH",
			category: "CACHE",
			blockId: lastUser.blockId,
			occurrence: lastUser.occurrence,
			ref: lastUser.ref,
			kind: lastUser.kind,
			mutability: lastUser.mutability,
			movable: false,
			why: "spec §16 L7: user content after instructions/tool noise breaks provider prefix caching; DO_NOT_TOUCH — reorder in your own assembly",
		});
	}

	const totalTokens = order.reduce((a, o) => a + o.tokens, 0);
	return {
		lanes,
		order,
		frontier,
		violations,
		summary: {
			blocks: order.length,
			totalTokens,
			stablePrefixTokens: cache?.stablePrefixTokens ?? 0,
			stablePrefixRatio: cache?.stablePrefixRatio ?? 0,
			movableAfterFrontier: movableAfterFrontier.length,
			manualAfterFrontier: manualAfterFrontier.length,
		},
	};
}

/**
 * MOVE candidates that the optimizer MAY offer (single-accept, never auto).
 * An op is produced only when the instance is genuinely movable by policy
 * (mutability === "SAFE_REORDER") AND sits after the frontier.
 *
 * `to` = absolute target index in the CURRENT manifest: the frontier index
 * (instances are inserted immediately before the first dynamic block, keeping
 * their relative order). Deterministic for a given manifest.
 *
 * No instance is ever mutated; a fresh manifest is returned alongside the
 * suggestions when the caller wants to preview the result.
 */
export function moveCandidates(manifest) {
	const report = layoutReport(manifest);
	const blocks = manifest?.blocks ?? [];
	const candidates = [];

	if (report.frontier) {
		const frontierIndex = report.frontier.index;
		// stable instances after the frontier, in natural order
		const victims = report.order.filter(
			(o) => o.index > frontierIndex && !isDynamicLike(o.effective) && o.movable,
		);
		// simulate inserting each before the frontier: later victims shift the
		// frontier right by one per earlier accepted move, so targets cascade.
		let target = frontierIndex;
		for (const v of victims) {
			candidates.push({
				ruleId: LAYOUT_RULE_ID,
				title: "Move stable block before the dynamic frontier",
				severity: "MEDIUM",
				category: "CACHE",
				blockId: v.blockId,
				occurrence: v.occurrence,
				ref: v.ref,
				kind: v.kind,
				why: v.violation?.why ?? report.violations.find((x) => x.ref === v.ref)?.why,
				requiresEval: false,
				autoApplicable: false, // §33 single-accept; never part of Apply-All
				op: {
					type: "MOVE_BLOCK",
					blockId: v.blockId,
					occurrence: v.occurrence,
					from: v.index,
					to: target,
					risk: "SAFE",
					reversible: true,
					why: "cache-safe layout: move SAFE_REORDER instance before the first dynamic block",
					cacheGainTokens: v.tokens,
					tokenDelta: 0,
				},
			});
			target += 1; // next accepted victim slots after this one, before frontier
		}
	}

	// Deduplicate against blocks that would conflict with a DELETE already in
	// flight is the caller's concern — these ops are offered per manifest and
	// applied one at a time (applyPatch STALE/occurrence guards).
	return { candidates, blocks: blocks.length, frontier: report.frontier };
}

/** Convenience: layout report + candidates in one deterministic bundle. */
export function layoutBundle(manifest) {
	return { report: layoutReport(manifest), moves: moveCandidates(manifest) };
}
