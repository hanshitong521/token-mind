/**
 * Optimizer — four modes, immutable input, DO_NOT_TOUCH via block.mutability,
 * reversible patch, risk-aware recommendation (spec §14 / §50 Step 7 /
 * ADR-0011; round-1 unresolved §12.1–§12.3).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrompt } from "../../lib/prompt-engine/parser.mjs";
import {
	OPTIMIZE_MODE,
	RECOMMENDATION,
	optimizeManifest,
	finalizeOptimization,
	normalizeMode,
	optimizeSafe,
	applySafeOptimization,
	verifyOptimization,
} from "../../lib/prompt-engine/optimizer.mjs";
import { applyPatch } from "../../lib/prompt-engine/patch.mjs";
import { optimize as optimizeEntry } from "../../lib/prompt-engine/index.mjs";
import { loadFixtures, fixtureById, deepFreeze } from "./_helpers.mjs";

const DUP_MD =
	"# Rules\n\n- Deterministic ordering before every request.\n- Never reorder arrays that carry sequence meaning.\n\n" +
	"# Rules\n\n- Deterministic ordering before every request.\n- Never reorder arrays that carry sequence meaning.\n";

const NEAR_DUP_MD =
	"# Rules\n\n- Never mutate the input manifest during optimization.\n- Always attach the rule id to a finding.\n\n" +
	"# Rules\n\n- Never mutate the input manifest during optimization.\n- Always attach the rule id to a finding!\n";

const CLEAN_PROMOTE_MD =
	"# Instructions\n\n- Always respond in the user's language.\n- Never guess missing parameters.\n\n" + DUP_MD;

const WHITESPACE_MD =
	"# Rules\n\n- behave deterministically  \n\n\n- never guess  \n\n# Rules\n\n- behave deterministically  \n\n\n- never guess  \n";

test("normalizeMode maps the four spec letters A–D", () => {
	assert.equal(normalizeMode("A"), OPTIMIZE_MODE.ANALYZE_ONLY);
	assert.equal(normalizeMode("B"), OPTIMIZE_MODE.SAFE);
	assert.equal(normalizeMode("C"), OPTIMIZE_MODE.CONSERVATIVE_REWRITE);
	assert.equal(normalizeMode("D"), OPTIMIZE_MODE.EXPERIMENTAL);
	assert.equal(normalizeMode(), OPTIMIZE_MODE.SAFE);
	assert.equal(normalizeMode("SAFE"), OPTIMIZE_MODE.SAFE);
	assert.throws(() => normalizeMode("E"));
});

test("Mode A (ANALYZE_ONLY) produces zero operations even on duplicated content", () => {
	const m = parsePrompt(DUP_MD, { sourceType: "markdown" });
	const r = optimizeManifest(m, { mode: "A" });
	assert.equal(r.mode, OPTIMIZE_MODE.ANALYZE_ONLY);
	assert.equal(r.patchOps.length, 0);
	assert.equal(r.summary.deltaTokens, 0);
	assert.equal(r.optimized.manifest.blocks.length, m.blocks.length, "mode A must not change the manifest");
});

test("Mode B deletes exactly the duplicate instance (A10-style: 2 blocks → 1)", () => {
	const m = parsePrompt(DUP_MD, { sourceType: "markdown" });
	const r = optimizeManifest(m, { mode: "B" });
	assert.equal(r.optimized.manifest.blocks.length, 1, "only the true duplicate should go");
	assert.equal(r.patchOps.length, 1);
	assert.equal(r.patchOps[0].type, "DELETE_DUPLICATE_BLOCK");
	assert.equal(r.patchOps[0].occurrence, 1, "must delete instance #1, never instance #0");
	assert.equal(r.patchOps[0].ruleId, "Q04-DUP-EXACT");
	assert.ok(r.summary.lossless_saved > 0);
	// the patch round-trips exactly onto the optimized manifest
	const applied = applyPatch(m, r.patch);
	assert.equal(applied.manifest.blocks[0].text, r.optimized.manifest.blocks[0].text);
});

test("Mode B input immutability: a deep-frozen manifest survives optimizeManifest", () => {
	const m = deepFreeze(parsePrompt(DUP_MD, { sourceType: "markdown" }));
	const snapshot = JSON.stringify(m);
	assert.doesNotThrow(() => optimizeManifest(m, { mode: "B" }));
	assert.equal(JSON.stringify(m), snapshot, "optimizer mutated a frozen manifest");
});

test("Mode B normalizes whitespace only on non-DO_NOT_TOUCH blocks and recomputes ids", () => {
	const m = parsePrompt(WHITESPACE_MD, { sourceType: "markdown" });
	const r = optimizeManifest(m, { mode: "B" });
	const normOps = r.patchOps.filter((o) => o.type === "NORMALIZE_BLOCK");
	assert.ok(normOps.length >= 1, "trailing-space blocks should be normalized");
	assert.ok(r.patchOps.some((o) => o.type === "DELETE_DUPLICATE_BLOCK"), "identical copies should also dedup");
	for (const b of r.optimized.manifest.blocks) {
		assert.ok(!/[ \t]+$/.test(b.text.split("\n").pop()), "trailing whitespace must be gone from optimized blocks");
	}
	// ids/hashes are consistent with content addressing
	for (const b of r.optimized.manifest.blocks) {
		assert.equal(b.hash.length, 64);
	}
});

test("DO_NOT_TOUCH is enforced from block.mutability: SQL fixture gets zero ops", () => {
	const { meta, content } = fixtureById("E01-sql");
	const r = optimizeEntry({ content, sourceType: meta.sourceType, options: { mode: "B" } });
	assert.equal(r.patchOps.length, 0, "protected SQL content must never be touched");
	assert.equal(r.verification.checks.dnt_preserved, true);
	assert.equal(r.recommendation.status, RECOMMENDATION.ANALYZE_ONLY);
});

test("DO_NOT_TOUCH blocks survive byte-identically through every optimizer run", () => {
	for (const { meta, content } of loadFixtures()) {
		const m = parsePrompt(content, { sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		const dnt = m.blocks.filter((b) => b.mutability === "DO_NOT_TOUCH");
		if (dnt.length === 0) continue;
		const r = optimizeManifest(m, { mode: "B" });
		const v = verifyOptimization(m, r.optimized.manifest, r.patch);
		assert.equal(v.checks.dnt_preserved, true, `${meta.id}: DO_NOT_TOUCH changed`);
	}
});

test("schema duplicates are SUGGESTIONS and are never auto-applied (tool_schema is DO_NOT_TOUCH)", () => {
	const { meta, content } = fixtureById("B02-duplicate-tool-schema");
	const r = optimizeEntry({ content, sourceType: meta.sourceType, provider: meta.provider, options: { mode: "B" } });
	assert.ok(r.suggestions.length >= 1, "schema dup must surface as a suggestion");
	assert.equal(r.patchOps.length, 0, "no schema op may be auto-applied");
	assert.equal(r.optimized.manifest.blocks.length, r.original.manifest.blocks.length);
});

test("Mode C surfaces semantic candidates as pending Eval work (no fabricated rewrite)", () => {
	const m = parsePrompt(NEAR_DUP_MD, { sourceType: "markdown" });
	const r = optimizeManifest(m, { mode: "C" });
	assert.ok(r.pendingEval.length >= 1, "near-duplicate pair must be pending");
	const fin = finalizeOptimization(r, {});
	assert.equal(fin.recommendation.status, RECOMMENDATION.EVAL_REQUIRED);
	assert.equal(fin.recommendation.apply, false);
	assert.equal(fin.recommendation.needsEval, true);
});

test("Mode D is an explicit downgrade in the static core (no compressor adapter)", () => {
	const m = parsePrompt(DUP_MD, { sourceType: "markdown" });
	const r = optimizeManifest(m, { mode: "D" });
	assert.equal(r.patchOps.length, 0, "no SAFE-class ops under an EXPERIMENTAL banner");
	const fin = finalizeOptimization(r, {});
	assert.equal(fin.recommendation.status, RECOMMENDATION.EXPERIMENTAL_UNAVAILABLE);
	assert.equal(fin.recommendation.apply, false);
	// even a claimed adapter does not fabricate lossy ops in this core
	const withAdapter = finalizeOptimization(optimizeManifest(m, { mode: "D", allowExperimental: true, compressorAdapter: true }), {});
	assert.equal(withAdapter.patchOps.length, 0);
});

test("optimizeSafe keeps the round-1 contract and honors occurrence addressing", () => {
	const m = parsePrompt(DUP_MD, { sourceType: "markdown" });
	const r = optimizeSafe(m);
	assert.equal(r.mode, "SAFE");
	assert.equal(r.optimized.blocks.length, 1);
	assert.equal(typeof r.summary.lossless_saved, "number");
	assert.equal(r.patch.operations.length, 1);
	const applied = applySafeOptimization(m);
	assert.equal(applied.optimized.blocks.length, 1);
});

test("recommendation vs publish gate: SAFE_APPLY does not require Eval; the gate does", () => {
	const { meta, content } = fixtureById("A10-duplicate-rule-blocks");
	const noAssert = optimizeEntry({ content, sourceType: meta.sourceType, options: { mode: "B" } });
	assert.equal(noAssert.recommendation.status, RECOMMENDATION.SAFE_APPLY);
	assert.equal(noAssert.recommendation.apply, true);
	assert.equal(noAssert.gate.checks.critical_assertions_pass, "UNKNOWN");
	assert.equal(noAssert.gate.recommendable, false, "publish gate must not clear without Eval evidence");

	// Providing Eval evidence flips the critical check — even when the
	// quality heuristic still objects to the dedup (removing the 2nd of two
	// rule blocks drops the structure sub-score below tolerance).
	const withAssert = optimizeEntry({ content, sourceType: meta.sourceType, options: { mode: "B", assertions: { pass: true } } });
	assert.equal(withAssert.gate.checks.critical_assertions_pass, "PASS");
	assert.equal(withAssert.recommendation.status, RECOMMENDATION.SAFE_APPLY);
	assert.equal(withAssert.gate.checks.quality_after_ge_before, "FAIL", "A10 2→1 blocks regresses the structure heuristic — by design");
});

test("a clean SAFE optimization clears every gate check once Eval evidence is supplied", () => {
	const m = parsePrompt(CLEAN_PROMOTE_MD, { sourceType: "markdown" });
	assert.equal(m.blocks.length, 3, "fixture must keep >=2 blocks after dedup so structure is stable");
	const r = optimizeEntry({
		content: CLEAN_PROMOTE_MD,
		sourceType: "markdown",
		options: { mode: "B", assertions: { pass: true } },
	});
	assert.equal(r.optimized.manifest.blocks.length, 2);
	assert.equal(r.recommendation.status, RECOMMENDATION.SAFE_APPLY);
	assert.equal(r.gate.checks.critical_assertions_pass, "PASS");
	assert.equal(r.gate.checks.rule_execution_complete, "PASS");
	assert.equal(r.gate.checks.safety_regression_zero, "PASS");
	assert.equal(r.gate.checks.quality_after_ge_before, "PASS");
	assert.equal(r.gate.checks.cache_stability_not_decreased, "PASS");
	assert.equal(r.gate.checks.token_not_increased, "PASS");
	assert.equal(r.gate.recommendable, true);
});

test("optimizer output bundles original / normalized / optimized / patch / fingerprint (P6)", () => {
	const { meta, content } = fixtureById("A10-duplicate-rule-blocks");
	const r = optimizeEntry({ content, sourceType: meta.sourceType, options: { mode: "B" } });
	for (const key of ["original", "normalized", "optimized"]) {
		assert.ok(r[key]?.manifest, `${key} manifest missing`);
		assert.ok(r[key]?.fingerprint?.rootHash, `${key} fingerprint missing`);
	}
	assert.ok(r.patch?.baseFingerprint);
	assert.equal(r.reverse.fullyReversible, false, "a DELETE cannot invert from ops alone");
	assert.ok(r.summary.lossless_saved > 0);
});

test("full fixture sweep: mode B optimization verifies clean on every fixture", () => {
	for (const { meta, content } of loadFixtures()) {
		const r = optimizeEntry({ content, sourceType: meta.sourceType ?? undefined, provider: meta.provider, options: { mode: "B" } });
		assert.equal(r.verification.ok, true, `${meta.id}: verification failed [${r.verification.failed}]`);
		assert.equal(r.verification.checks.rules_complete_before, true, `${meta.id}`);
		assert.equal(r.verification.checks.rules_complete_after, true, `${meta.id}`);
		assert.equal(r.summary.deltaTokens <= 0, true, `${meta.id}: tokens grew after SAFE optimization`);
		if (meta.secretValues?.length) {
			const text = (r.optimized.manifest.blocks ?? []).map((b) => b.text).join("\n");
			for (const secret of meta.secretValues) {
				assert.ok(!text.includes(secret), `${meta.id}: secret leaked into optimized output`);
			}
		}
	}
});

test("optimize() returns an ANALYZE_ONLY recommendation when there is nothing safe to do", () => {
	const { meta, content } = fixtureById("D09-stable-baseline");
	const r = optimizeEntry({ content, sourceType: meta.sourceType ?? undefined, options: { mode: "B" } });
	assert.equal(r.patchOps.length, 0);
	assert.equal(r.recommendation.status, RECOMMENDATION.ANALYZE_ONLY);
	assert.equal(r.verification.ok, true);
});

test("normalized manifest differs from optimized only by deletions", () => {
	const m = parsePrompt(WHITESPACE_MD, { sourceType: "markdown" });
	const r = optimizeManifest(m, { mode: "B" });
	assert.equal(r.normalized.manifest.blocks.length, m.blocks.length, "normalized keeps every block");
	assert.ok(r.optimized.manifest.blocks.length < r.normalized.manifest.blocks.length, "optimized additionally dedups");
});
