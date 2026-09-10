/**
 * Safe Optimizer — four-mode, immutable, reversible (spec §14 / §50 Step 7,
 * ADR-0011).
 *
 * Round-2 rewrite fixes the three hard flaws the round-1 audit left open:
 *   1. §12.1 shallow-copy mutation — every pass is pure; input blocks are
 *      NEVER written. All change flows through instance-addressed patch ops
 *      (patch.mjs) and applyPatch builds fresh block objects.
 *   2. §12.1 regex "protection" — DO_NOT_TOUCH is enforced from
 *      `block.mutability`, which the parser derives from §15 content classes
 *      (untouchableLabels), not from a second copy of those regexes.
 *   3. §12.1 private tokenizer — token deltas reuse `lib/tokens.mjs`
 *      (countTokens), the same estimator tagged on every block. No local
 *      "chars/4" reimplementation masquerades as the real one.
 *
 * Mode contract (spec §14):
 *   A  ANALYZE_ONLY            analyze; zero ops (default of the lab is A)
 *   B  SAFE                    exact dedup + safe whitespace normalization
 *                              + schema-dup SUGGESTIONS (never auto-applied:
 *                              tool_schema blocks are §15 DO_NOT_TOUCH)
 *   C  CONSERVATIVE_REWRITE    B subset + semantic candidates surfaced as
 *                              pending (requires Eval; static core never
 *                              fabricates LLM rewrites, P10)
 *   D  EXPERIMENTAL            off by default; no lossy compressor adapter is
 *                              wired into the static core → explicit refusal
 *                              (ADR-0010-style downgrade, never a silent no-op)
 *
 * P6: every result keeps original / normalized / optimized / patch /
 * fingerprint so each step is reversible.
 */

import { canonicalizeBlockText } from "./canonicalizer.mjs";
import { createPatch, applyPatch, rebuildBlock, reverseOps, patchRiskOf, OP } from "./patch.mjs";
import { findExactDuplicates, findSchemaDuplicates, findNearDuplicates } from "./duplicate-detector.mjs";
import { inspectSafety } from "./safety-rules.mjs";
import { computeFingerprint } from "./fingerprint.mjs";
import { analyzeCacheStability } from "./cache-analyzer.mjs";

export const OPTIMIZE_MODE = Object.freeze({
	ANALYZE_ONLY: "ANALYZE_ONLY",
	SAFE: "SAFE",
	CONSERVATIVE_REWRITE: "CONSERVATIVE_REWRITE",
	EXPERIMENTAL: "EXPERIMENTAL",
});

/** A→ANALYZE_ONLY, B→SAFE, C→CONSERVATIVE_REWRITE, D→EXPERIMENTAL (spec §14). */
const MODE_BY_LETTER = Object.freeze({
	A: OPTIMIZE_MODE.ANALYZE_ONLY,
	B: OPTIMIZE_MODE.SAFE,
	C: OPTIMIZE_MODE.CONSERVATIVE_REWRITE,
	D: OPTIMIZE_MODE.EXPERIMENTAL,
});

export function normalizeMode(mode) {
	if (mode === undefined || mode === null) return OPTIMIZE_MODE.SAFE;
	const up = String(mode).toUpperCase();
	if (MODE_BY_LETTER[up]) return MODE_BY_LETTER[up];
	if (OPTIMIZE_MODE[up]) return up;
	throw new Error(
		`unknown optimize mode "${mode}"; use A/B/C/D or ${Object.values(OPTIMIZE_MODE).join(" / ")}`,
	);
}

export const RECOMMENDATION = Object.freeze({
	ANALYZE_ONLY: "ANALYZE_ONLY", // nothing produced (mode A / empty patch)
	SAFE_APPLY: "SAFE_APPLY", // SAFE subset verified, recommended to apply
	EVAL_REQUIRED: "EVAL_REQUIRED", // semantic candidates pending; run Eval first
	BLOCKED: "BLOCKED", // verification failed / rules broken / risk over tolerance
	EXPERIMENTAL_UNAVAILABLE: "EXPERIMENTAL_UNAVAILABLE", // mode D w/o compressor
});

function isUntouchable(block) {
	return block?.mutability === "DO_NOT_TOUCH";
}

/** Occurrence (0-based) of every manifest block, keyed by block object. */
function occurrenceIndex(blocks) {
	const counts = new Map();
	const map = new Map();
	for (let i = 0; i < blocks.length; i += 1) {
		const b = blocks[i];
		const occ = counts.get(b.id) ?? 0;
		counts.set(b.id, occ + 1);
		map.set(b, occ);
	}
	return map;
}

// ─── passes ────────────────────────────────────────────────────────────────

/**
 * Pass 1 — exact duplicate removal. Instance-addressed: only the copies after
 * the first occurrence of a duplicate group are deleted (fixes §12.3 where a
 * content-addressed id made DELETE remove EVERY copy). A group is skipped
 * wholesale when any member is DO_NOT_TOUCH.
 */
export function exactDedupOps(manifest) {
	const blocks = manifest?.blocks ?? [];
	const groups = findExactDuplicates(manifest); // non-tool, same content hash
	const occOf = occurrenceIndex(blocks);
	const ops = [];
	if (groups.length === 0) return ops;

	for (const group of groups) {
		if (group.length < 2) continue;
		if (group.some(isUntouchable)) continue; // §15 protected content
		for (const dup of group.slice(1)) {
			const occ = occOf.get(dup) ?? 0;
			ops.push({
				type: OP.DELETE_DUPLICATE_BLOCK,
				blockId: dup.id,
				occurrence: occ,
				ruleId: "Q04-DUP-EXACT",
				why: "byte-identical block kept once; removing this instance is lossless",
				before: dup.text,
				tokenDelta: -(dup.tokenCount?.count ?? 0),
				cacheDelta: 0,
				risk: "SAFE",
				reversible: false, // restore from the P6 original snapshot
			});
		}
	}
	return ops;
}

/**
 * Pass 2 — schema duplicate SUGGESTIONS. tool_schema blocks are DO_NOT_TOUCH
 * (spec §15: JSON Schema), so no mode auto-applies this — spec §14 Mode B
 * itself calls it "去重建议".
 */
export function schemaDupSuggestions(manifest) {
	const blocks = manifest?.blocks ?? [];
	const occOf = occurrenceIndex(blocks);
	const dups = findSchemaDuplicates(manifest);
	return dups.map(({ name, groupA, groupB }) => ({
		ruleId: "Q12-SCHEMA-DUP",
		title: `Tool schema "${name}" defined twice`,
		severity: "HIGH",
		category: "QUALITY",
		tokenDelta: -groupB.reduce((a, e) => a + (e.block.tokenCount?.count ?? 0), 0),
		blockRefs: groupB.map((e) => ({ blockId: e.block.id, occurrence: occOf.get(e.block) ?? 0 })),
		proposal: "delete the duplicate schema entries after explicit review",
		why: "identical schema fingerprint repeated; one definition is redundant",
		reason: "target blocks are DO_NOT_TOUCH (spec §15); stays a suggestion — apply is never automatic",
	}));
}

/**
 * Pass 3 — safe whitespace normalization on blocks whose mutability permits
 * compaction. Fenced content is preserved by canonicalizeBlockText; block
 * identity/hash/token count are recomputed by the patch (rebuildBlock).
 * `skipRefs` (instance refs of blocks already scheduled for deletion by the
 * dedup pass) are never normalized — normalizing an instance that the same
 * patch deletes would be an OP_CONFLICT.
 */
export function normalizeOps(manifest, { skipRefs = null } = {}) {
	const blocks = manifest?.blocks ?? [];
	const occOf = occurrenceIndex(blocks);
	const skip = skipRefs instanceof Set ? skipRefs : new Set();
	const ops = [];
	for (const b of blocks) {
		if (isUntouchable(b)) continue;
		if (b.kind === "code" || b.kind === "diff" || b.kind === "tool_schema" || b.kind === "tool_result" || b.kind === "history") continue;
		const occ = occOf.get(b) ?? 0;
		if (skip.has(refKey(b.id, occ))) continue; // being deleted by dedup
		const normalized = canonicalizeBlockText(b.text);
		if (normalized === b.text) continue;
		const next = rebuildBlock(b, normalized);
		ops.push({
			type: OP.NORMALIZE_BLOCK,
			blockId: b.id,
			occurrence: occ,
			text: normalized,
			afterId: next.id,
			before: b.text,
			ruleId: "NORMALIZE",
			why: "whitespace normalization that preserves fences and meaning",
			tokenDelta: (next.tokenCount?.count ?? 0) - (b.tokenCount?.count ?? 0),
			cacheDelta: 0,
			risk: "SAFE",
			reversible: true,
		});
	}
	return ops;
}

function refKey(blockId, occurrence) {
	return `${blockId}#${occurrence}`;
}

/** Mode C semantic candidates (near-duplicate merges etc.) — pending Eval. */
export function semanticCandidates(manifest) {
	const blocks = manifest?.blocks ?? [];
	const occOf = occurrenceIndex(blocks);
	return findNearDuplicates(manifest).map(({ a, b }) => ({
		ruleId: "Q04-DUP-NEAR",
		title: "Near-duplicate blocks — merge candidate",
		severity: "LOW",
		category: "QUALITY",
		requiresEval: true,
		blockRefs: [
			{ blockId: a.id, occurrence: occOf.get(a) ?? 0 },
			{ blockId: b.id, occurrence: occOf.get(b) ?? 0 },
		],
		proposal: "merge after an Eval confirms semantics are equivalent",
		why: "high token-similarity content in two blocks; merging is a SEMANTIC_REWRITE and needs P10 Eval",
		// Executable SEMANTIC ops (Step 10 / ADR-0013). The static core never
		// APPLIES these; the Eval round confirms and the human applies via the
		// patch vocabulary. Line-union merge preserves both texts by content.
		ops: buildMergeOps(blocks, a, b, occOf),
		risk: "SEMANTIC_REWRITE",
	}));
}

/** Build a MERGE_BLOCKS op that consolidates two near-duplicate instances. */
function buildMergeOps(blocks, a, b, occOf) {
	const idxA = blocks.indexOf(a);
	const idxB = blocks.indexOf(b);
	if (idxA < 0 || idxB < 0) return [];
	const mergedText = unionLines(a.text ?? "", b.text ?? "");
	const baseBlock = {
		kind: a.kind,
		role: a.role ?? null,
		stability: a.stability,
		mutability: a.mutability,
		text: mergedText,
	};
	// Full block shape (id/hash/tokenCount re-derived from the merged text)
	// so persisted blocks stay self-describing for consumers (store, export).
	const mergedBlock = rebuildBlock(baseBlock, mergedText);
	return [
		{
			type: OP.MERGE_BLOCKS,
			blockIds: [
				{ blockId: a.id, occurrence: occOf.get(a) ?? 0 },
				{ blockId: b.id, occurrence: occOf.get(b) ?? 0 },
			],
			to: Math.min(idxA, idxB),
			block: mergedBlock,
			why: "conservative merge of near-duplicate blocks (P10: Eval before apply)",
			risk: "SEMANTIC_REWRITE",
		},
	];
}

/** First-seen distinct-line union of two block texts. */
function unionLines(x, y) {
	const seen = new Set();
	const out = [];
	for (const text of [x, y]) {
		for (const line of String(text ?? "").split("\n")) {
			const key = line.trim();
			if (!key || seen.has(key)) continue;
			seen.add(key);
			out.push(line);
		}
	}
	return out.join("\n");
}

// ─── verification ──────────────────────────────────────────────────────────

/**
 * Post-apply verification — the optimizer's own measurement of "SAFE is
 * safe". Independent of the publish gate (which additionally demands Eval for
 * promotion): this answers "does the patch do what it claims?"
 *
 * checks:
 *  dnt_preserved         every DO_NOT_TOUCH instance survives byte-identical
 *  patch_applies_clean   applyPatch ok, zero skipped ops
 *  ops_risk_safe         no op above SAFE risk in the produced patch
 *  token_not_increased   estimated total did not grow
 *  rules_complete_*      (optional) rule execution reports both complete
 */
export function verifyOptimization(original, optimized, patch, { runBefore = null, runAfter = null } = {}) {
	const checks = {};
	const dntCounts = (blocks) => {
		const m = new Map();
		for (const b of blocks) {
			if (b.mutability !== "DO_NOT_TOUCH") continue;
			m.set(b.hash, (m.get(b.hash) ?? 0) + 1);
		}
		return m;
	};
	const before = dntCounts(original?.blocks ?? []);
	const after = dntCounts(optimized?.blocks ?? []);
	let dntPreserved = before.size === after.size;
	if (dntPreserved) for (const [h, n] of before) if (after.get(h) !== n) dntPreserved = false;
	checks.dnt_preserved = dntPreserved;

	let patchApplies = false;
	let skipped = null;
	try {
		const r = applyPatch(original, patch, { onStale: "return" });
		patchApplies = r.ok === true && (r.skipped?.length ?? 0) === 0;
		skipped = r.skipped ?? [];
	} catch {
		patchApplies = false;
	}
	checks.patch_applies_clean = patchApplies;

	checks.ops_risk_safe = (patch?.operations ?? []).every((o) => (o.risk ?? "SAFE") === "SAFE") && patchRiskOf(patch?.operations) === "SAFE";

	const beforeTokens = (original?.blocks ?? []).reduce((a, b) => a + (b.tokenCount?.count ?? 0), 0);
	const afterTokens = (optimized?.blocks ?? []).reduce((a, b) => a + (b.tokenCount?.count ?? 0), 0);
	checks.token_not_increased = afterTokens <= beforeTokens;

	if (runBefore) checks.rules_complete_before = runBefore.complete === true;
	if (runAfter) checks.rules_complete_after = runAfter.complete === true;

	const required = ["dnt_preserved", "patch_applies_clean", "ops_risk_safe", "token_not_increased"];
	const failed = required.filter((c) => checks[c] !== true);
	return {
		ok: failed.length === 0,
		checks,
		failed,
		details: { skipped, beforeTokens, afterTokens },
	};
}

// ─── recommendation ────────────────────────────────────────────────────────

/**
 * Risk-aware recommendation. Deliberately separate from the §17.6 publish
 * gate: the gate answers "promote to production?" and demands Eval evidence
 * (critical_assertions_pass). This answers "apply this patch to your file
 * now?" and, for a patch whose ops are all SAFE, Eval is NOT required (P10
 * gates SEMANTIC_REWRITE-and-above only).
 */
export function recommendFor({
	mode = OPTIMIZE_MODE.SAFE,
	patch = null,
	verification = null,
	gate = null,
	pendingEval = [],
	suggestions = [],
	allowExperimental = false,
	compressorAdapter = false,
} = {}) {
	const ops = patch?.operations ?? [];
	const reasons = [];
	const patchRisk = patchRiskOf(ops);

	if (mode === OPTIMIZE_MODE.EXPERIMENTAL) {
		if (!allowExperimental || !compressorAdapter) {
			return {
				status: RECOMMENDATION.EXPERIMENTAL_UNAVAILABLE,
				apply: false,
				needsEval: true,
				patchRisk: "EXPERIMENTAL",
				reasons: ["Mode D needs allowExperimental AND a lossy compressor adapter; the static core wires neither (ADR-0010-style explicit downgrade)"],
				pendingCount: pendingEval.length,
				suggestionCount: suggestions.length,
			};
		}
	}

	if (gate?.checks?.rule_execution_complete === "FAIL" || verification?.checks?.rules_complete_before === false || verification?.checks?.rules_complete_after === false) {
		return { status: RECOMMENDATION.BLOCKED, apply: false, needsEval: true, patchRisk, reasons: ["rules are broken or did not fully execute; no finding is trustworthy"], pendingCount: pendingEval.length, suggestionCount: suggestions.length };
	}

	if (ops.length > 0 && verification && !verification.ok) {
		reasons.push(...verification.failed.map((c) => `verification: ${c}`));
		return { status: RECOMMENDATION.BLOCKED, apply: false, needsEval: false, patchRisk, reasons, pendingCount: pendingEval.length, suggestionCount: suggestions.length };
	}

	if (gate && gate.checks.safety_regression_zero === "FAIL") {
		reasons.push("risk score over tolerance after optimization");
		return { status: RECOMMENDATION.BLOCKED, apply: false, needsEval: false, patchRisk, reasons, pendingCount: pendingEval.length, suggestionCount: suggestions.length };
	}

	if (mode === OPTIMIZE_MODE.CONSERVATIVE_REWRITE && pendingEval.length > 0) {
		reasons.push(`${pendingEval.length} semantic candidate(s) require P10 Eval before apply`);
		return { status: RECOMMENDATION.EVAL_REQUIRED, apply: false, needsEval: true, patchRisk, reasons, pendingCount: pendingEval.length, suggestionCount: suggestions.length };
	}

	if (ops.length === 0) {
		return { status: RECOMMENDATION.ANALYZE_ONLY, apply: false, needsEval: false, patchRisk, reasons: ["no operations produced"], pendingCount: pendingEval.length, suggestionCount: suggestions.length };
	}

	if (patchRisk === "SAFE" && (verification?.ok ?? true)) {
		reasons.push("every op is SAFE; verification passed; token total did not increase");
		return { status: RECOMMENDATION.SAFE_APPLY, apply: true, needsEval: false, patchRisk, reasons, pendingCount: pendingEval.length, suggestionCount: suggestions.length };
	}

	return { status: RECOMMENDATION.EVAL_REQUIRED, apply: false, needsEval: true, patchRisk, reasons: ["patch contains non-SAFE operations; Eval required (P10)"], pendingCount: pendingEval.length, suggestionCount: suggestions.length };
}

// ─── main entry ────────────────────────────────────────────────────────────

/**
 * Pure optimizer. Input manifest is never mutated (deep-cloned before any
 * work). Returns the P6 bundle:
 *   original / normalized / optimized (manifests + fingerprints)
 *   patch / patchOps / reverse
 *   findings / suggestions / pendingEval
 *   verification / recommendation / summary
 *
 * options:
 *   mode                 A|B|C|D (default B=SAFE)
 *   allowExperimental    Mode D flag
 *   compressorAdapter    Mode D: whether a lossy compressor is actually wired
 */
export function optimizeManifest(manifest, { mode: modeArg, allowExperimental = false, compressorAdapter = false } = {}) {
	const mode = normalizeMode(modeArg);
	const original = structuredClone(manifest);

	const safetyFindings = inspectSafety(original);

	// Passes produce ops (deterministic, ordered: dedup then normalize).
	// Mode D in this static core owns NO compressor adapter, so it does not
	// even emit SAFE-class ops under an EXPERIMENTAL banner — recommendFor
	// returns an explicit EXPERIMENTAL_UNAVAILABLE downgrade instead.
	const runPasses = mode === OPTIMIZE_MODE.SAFE || mode === OPTIMIZE_MODE.CONSERVATIVE_REWRITE;
	const dedup = runPasses ? exactDedupOps(original) : [];
	const deleteRefs = new Set(dedup.map((o) => refKey(o.blockId, o.occurrence ?? 0)));
	const normalize = runPasses ? normalizeOps(original, { skipRefs: deleteRefs }) : [];
	const operations = [...dedup, ...normalize];

	const suggestions = schemaDupSuggestions(original); // all modes (analyze shows them too)
	const pendingEval = mode === OPTIMIZE_MODE.CONSERVATIVE_REWRITE ? semanticCandidates(original) : [];

	const fullPatch = createPatch({
		baseBlocks: original.blocks,
		operations,
		risk: patchRiskOf(operations),
		evidence: { mode, safetyFindings: safetyFindings.length, suggestions: suggestions.length, pendingEval: pendingEval.length },
		metadata: { optimizedPass: mode },
	});

	// normalized (P6): only the NORMALIZE ops applied
	const normalizePatch = createPatch({
		baseBlocks: original.blocks,
		operations: normalize,
		risk: patchRiskOf(normalize),
		metadata: { optimizedPass: `${mode}-normalize-only` },
	});
	const normalizedManifest = applyPatch(original, normalizePatch, { onStale: "throw" }).manifest;

	const applyResult = applyPatch(original, fullPatch, { onStale: "throw" });
	const optimized = {
		...applyResult.manifest,
		metadata: { ...(original.metadata ?? {}), optimizedPass: mode },
	};

	const fp = (m) => {
		const cache = analyzeCacheStability(m);
		return computeFingerprint(m, { stablePrefixTokens: cache.stablePrefixTokens, firstDynamicBlock: cache.firstDynamicBlock });
	};

	const tokensOf = (m) => (m?.blocks ?? []).reduce((a, b) => a + (b.tokenCount?.count ?? 0), 0);

	return {
		mode,
		original: { manifest: original, fingerprint: fp(original), tokens: tokensOf(original) },
		normalized: { manifest: normalizedManifest, fingerprint: fp(normalizedManifest), tokens: tokensOf(normalizedManifest) },
		optimized: { manifest: optimized, fingerprint: fp(optimized), tokens: tokensOf(optimized) },
		patch: fullPatch,
		patchOps: operations,
		reverse: reverseOps(fullPatch),
		findings: safetyFindings,
		suggestions,
		pendingEval,
		applyResult,
		summary: {
			mode,
			beforeTokens: tokensOf(original),
			afterTokens: tokensOf(optimized),
			deltaTokens: tokensOf(optimized) - tokensOf(original),
			lossless_saved: Math.max(0, tokensOf(original) - tokensOf(optimized)),
			semantic_rewrite_saved: 0,
			lossy_saved: 0,
			appliedOps: operations.length,
			pendingEval: pendingEval.length,
			suggestions: suggestions.length,
		},
		// verification + recommendation are filled by the caller that owns
		// rule execution; see index.optimize → finalizeOptimization().
	};
}

/**
 * Attach verification (with rule reports) + risk-aware recommendation.
 * Split out so index.optimize can feed both sides' ruleExecution into the
 * gate and verification without optimizer.mjs importing index.mjs.
 */
export function finalizeOptimization(result, { runBefore = null, runAfter = null, gate = null, assertionsPass = false } = {}) {
	const verification = verifyOptimization(result.original.manifest, result.optimized.manifest, result.patch, { runBefore, runAfter });
	const recommendation = recommendFor({
		mode: result.mode,
		patch: result.patch,
		verification,
		gate,
		pendingEval: result.pendingEval,
		suggestions: result.suggestions,
	});
	return { ...result, verification, recommendation, assertions: { pass: assertionsPass } };
}

// ─── round-1 compatibility wrappers ─────────────────────────────────────────

/**
 * optimizeSafe(manifest) — round-1 entry, now backed by the pure engine.
 * Shape kept: { mode, original, optimized, patch, appliedOps, safetyFindings,
 * summary }.
 */
export function optimizeSafe(manifest, options = {}) {
	const result = optimizeManifest(manifest, { ...options, mode: options.mode ?? OPTIMIZE_MODE.SAFE });
	return {
		mode: "SAFE",
		original: result.original.manifest,
		optimized: result.optimized.manifest,
		patch: result.patch,
		appliedOps: result.patchOps.length,
		safetyFindings: result.findings,
		suggestions: result.suggestions,
		pendingEval: result.pendingEval,
		verification: result.verification ?? null,
		recommendation: result.recommendation ?? null,
		summary: result.summary,
	};
}

/** Round-1 alias: compute then apply to a fresh copy (pure). */
export function applySafeOptimization(manifest, options = {}) {
	const result = optimizeManifest(manifest, { ...options, mode: options.mode ?? OPTIMIZE_MODE.SAFE });
	return { ...result, optimized: result.optimized.manifest };
}
