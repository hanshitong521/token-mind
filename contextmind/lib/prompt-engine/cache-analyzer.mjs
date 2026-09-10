/**
 * Cache Stability Analyzer — stable-prefix estimation & cache score.
 *
 * Prompt Lab spec §11: compute
 *  stable_prefix_tokens / stable_prefix_ratio
 *  first_dynamic_block / first_dynamic_token_offset
 *  cache_breaker_count (CACHE_PREFIX_BREAKER findings)
 * and the Cache Stability Score (§17.2).
 *
 * Stable prefix = token length of the longest leading run of blocks whose
 * stability is STATIC/MOSTLY_STATIC AND contain no volatile span. The first
 * truly dynamic/volatile block marks the prefix boundary.
 */


import { countTokens } from "../tokens.mjs";
import { analyzeBlockVolatility } from "./volatility.mjs";
import { classifyBlock } from "./segment-classifier.mjs";

/**
 * Compute stable prefix metrics for a manifest.
 * Returns { stablePrefixTokens, stablePrefixRatio, firstDynamicBlock,
 *           firstDynamicTokenOffset, cacheBreakerCount, totalTokens,
 *           prefix: [{blockId, tokens, stable}], volatileBlocks }
 */
export function analyzeCacheStability(manifest) {
	const blocks = manifest?.blocks ?? [];
	const breakdown = [];
	let stablePrefixTokens = 0;
	let firstDynamicBlock = null;
	let firstDynamicTokenOffset = null;
	let cacheBreakerCount = 0;
	let volatileBlocks = [];
	let prefixLength = 0;
	let prefixTokenOffset = 0;

	for (const b of blocks) {
		const t = b.tokenCount?.count ?? countTokens(b.text ?? "");
		const { stability: declared, effective } = classifyBlock(b);
		const vol = analyzeBlockVolatility(b);

		// Effective (content-aware) class drives the prefix: a "rule" block that
		// in fact carries a live timestamp must not count toward a stable prefix
		// just because its kind says STATIC.
		const inPrefix =
			(effective === "STATIC" || effective === "MOSTLY_STATIC") &&
			!vol.volatile;

		prefixLength += 1;
		prefixTokenOffset += t;

		// first block that ends any usable prefix
		if (firstDynamicBlock === null && (effective === "DYNAMIC" || effective === "EPHEMERAL" || vol.volatile)) {
			firstDynamicBlock = b.id;
			firstDynamicTokenOffset = prefixTokenOffset - t;
		}
		// CACHE_PREFIX_BREAKER: claims the stable region, carries volatile content
		if ((declared === "STATIC" || declared === "MOSTLY_STATIC") && vol.volatile) {
			cacheBreakerCount += 1;
			volatileBlocks.push({ blockId: b.id, spans: vol.spans });
		}
		if (inPrefix) {
			stablePrefixTokens += t;
		}
	}

	// Stop accumulation at the first dynamic block: later text never counts
	// toward a usable prefix.
	if (firstDynamicBlock !== null) {
		const idx = blocks.findIndex((b) => b.id === firstDynamicBlock);
		const totalAbove =
			idx < 0 ? stablePrefixTokens : blocks.slice(0, idx).reduce((a, b) => a + (b.tokenCount?.count ?? 0), 0);
		stablePrefixTokens = Math.min(stablePrefixTokens, totalAbove);
	}

	const totalTokens = blocks.reduce((a, b) => a + (b.tokenCount?.count ?? 0), 0);
	const stablePrefixRatio = totalTokens > 0 ? stablePrefixTokens / totalTokens : 0;

	return {
		totalTokens,
		stablePrefixTokens,
		stablePrefixRatio: Number(stablePrefixRatio.toFixed(4)),
		firstDynamicBlock,
		firstDynamicTokenOffset,
		cacheBreakerCount,
		volatileBlocks,
		totalBlocks: blocks.length,
		stableBlocks: blocks.filter((b) => {
			const { effective } = classifyBlock(b);
			return effective === "STATIC" || effective === "MOSTLY_STATIC";
		}).length,
	};
}

/**
 * Cache Stability Score / 100 (spec §17.2):
 *   stable_prefix_ratio * 0.35
 * - early_volatility penalty  0.25 (per breaker found)
 * - deterministic_ordering   0.20 (tool contiguity + no user-before-tools)
 * - dynamic_isolation        0.10 (dynamic blocks at end, none in static zone)
 * - tool_schema_stability    0.10 (all schemas contiguous, no dup)
 * Each dimension 0..100.
 */
export function cacheStabilityScore(manifest, metrics = null) {
	const m = metrics ?? analyzeCacheStability(manifest);
	const blocks = manifest?.blocks ?? [];

	const ratioScore = Math.round((m.stablePrefixRatio ?? 0) * 100);

	const volatilityScore = Math.max(0, 100 - 25 * (m.cacheBreakerCount ?? 0));

	const toolIdx = blocks.map((b, i) => (b.kind === "tool_schema" ? i : -1)).filter((i) => i >= 0);
	let orderingScore =
		toolIdx.length <= 1 ? 100
		: toolIdx.every((idx, i) => i === 0 || idx === toolIdx[i - 1] + 1) ? 100
		: 40;
	const userIdx = blocks.findIndex((b) => b.kind === "user_request" || b.role === "user");
	if (userIdx >= 0 && toolIdx.length > 0 && userIdx < toolIdx[0]) {
		// user-before-tools is a hard ordering violation: the dynamic tail sits
		// inside the stable region. Reported by CACHE-002; scored here.
		orderingScore = 40;
	}

	let dynamicEphemeral = blocks.filter((b) => {
		const { effective } = classifyBlock(b);
		return effective === "DYNAMIC" || effective === "EPHEMERAL";
	});
	const lastDynamicIdx = dynamicEphemeral.length ? blocks.indexOf(dynamicEphemeral[dynamicEphemeral.length - 1]) : -1;
	// "Isolated" means every dynamic block sits in the tail; a dynamic block in
	// the middle truncates the prefix.
	const firstDynamicIdx = dynamicEphemeral.length ? blocks.indexOf(dynamicEphemeral[0]) : -1;
	const isolationScore =
		lastDynamicIdx === -1 ? 100
		: firstDynamicIdx >= Math.max(0, blocks.length - 3) ? 100
		: blocks.length === 0 ? 100
		: 55;

	const schemaDupCount = countSchemaDup(blocks);
	const schemaScore = schemaDupCount === 0 ? 100 : Math.max(0, 100 - 20 * schemaDupCount);

	const score = Math.round(
		ratioScore * 0.35 +
			volatilityScore * 0.25 +
			orderingScore * 0.20 +
			isolationScore * 0.10 +
			schemaScore * 0.10,
	);
	return {
		score,
		dimensions: {
			stable_prefix_ratio: m.stablePrefixRatio,
			stable_prefix_tokens: m.stablePrefixTokens,
			early_volatility: m.cacheBreakerCount,
			deterministic_ordering: orderingScore,
			dynamic_isolation: isolationScore,
			tool_schema_stability: schemaScore,
		},
	};
}

function countSchemaDup(blocks) {
	const schemaBlocks = blocks.filter((b) => b.kind === "tool_schema");
	const names = new Map();
	for (const b of schemaBlocks) {
		let name = null;
		try {
			name = JSON.parse(b.text)?.name;
		} catch {
			name = null;
		}
		if (name == null) continue;
		names.set(name, (names.get(name) ?? 0) + 1);
	}
	return [...names.values()].filter((n) => n > 1).length;
}

/**
 * Cache regression between two manifests (spec §11.5 / §24 cache layer).
 *
 * A regression is a LOST PREFIX: fewer stable prefix tokens, or the first
 * dynamic block moving earlier. It is explicitly NOT a drop in the ratio that
 * comes from the dynamic tail simply getting longer — the reusable prefix is
 * unchanged in that case, and flagging it made every ordinary "user wrote a
 * longer request" round look like a 60% cache regression.
 */
export function compareCacheRegression(a, b) {
	const ma = analyzeCacheStability(a);
	const mb = analyzeCacheStability(b);
	const diffTokens = mb.stablePrefixTokens - ma.stablePrefixTokens;
	const diffRatio = mb.stablePrefixRatio - ma.stablePrefixRatio;

	const idxOf = (m) => {
		const blocks = m.blocks ?? [];
		const i = blocks.findIndex((x) => x.id === m.firstDynamicBlock);
		return i < 0 ? blocks.length : i;
	};
	const idxA = idxOf(a.blocks ? a : { blocks: [], firstDynamicBlock: null });
	const idxB = idxOf(b.blocks ? b : { blocks: [], firstDynamicBlock: null });

	const prefixShrank = diffTokens < 0;
	const breakerMovedEarlier = idxB < idxA;
	const regression = prefixShrank || breakerMovedEarlier;

	return {
		baseline: ma,
		current: mb,
		regression,
		reason: prefixShrank
			? `stable prefix shrank by ${-diffTokens} tokens`
			: breakerMovedEarlier
				? `first dynamic block moved ${idxA - idxB} position(s) earlier`
				: "stable prefix preserved",
		stablePrefixDeltaTokens: diffTokens,
		stablePrefixDeltaRatio: Number(diffRatio.toFixed(4)),
		firstDynamicIndexBefore: idxA,
		firstDynamicIndexAfter: idxB,
		firstDynamicChanged: ma.firstDynamicBlock !== mb.firstDynamicBlock,
	};
}