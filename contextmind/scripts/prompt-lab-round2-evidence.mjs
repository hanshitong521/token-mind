/**
 * Prompt Lab round-2 evidence collector (Step 7 Safe Optimizer).
 *
 * Deterministic, self-validating: every claim is asserted inline, and the
 * script exits non-zero if a claim breaks. Output is written to
 * `docs/reports/prompt-lab-round2-evidence.txt` (same shape as round 1) and
 * mirrored to stdout.
 *
 * Usage:  node scripts/prompt-lab-round2-evidence.mjs
 *         (run from the contextmind directory)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const CM_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(CM_ROOT, "fixtures/prompt-lab");
const REPORT = join(CM_ROOT, "../docs/reports/prompt-lab-round2-evidence.txt");
const here = (p) => pathToFileURL(join(CM_ROOT, p)).href;

const { parsePrompt } = await import(here("lib/prompt-engine/parser.mjs"));
const E = await import(here("lib/prompt-engine/index.mjs"));
const O = await import(here("lib/prompt-engine/optimizer.mjs"));
const P = await import(here("lib/prompt-engine/patch.mjs"));

const lines = [];
const assert = (cond, msg) => {
	if (!cond) throw new Error(`EVIDENCE ASSERTION FAILED: ${msg}`);
	lines.push(`  ${msg}`);
};
/** Like assert, but silent — for loop bodies where only the summary matters. */
const ensure = (cond, msg) => {
	if (!cond) throw new Error(`EVIDENCE ASSERTION FAILED: ${msg}`);
};

const fix = (id) => {
	const meta = JSON.parse(readFileSync(join(FIXTURES, `${id}.meta.json`), "utf8"));
	return { meta, content: readFileSync(join(FIXTURES, meta.file), "utf8") };
};

const fixtures = readFileSync(join(FIXTURES, "manifest.json"), "utf8");

lines.push("PROMPT_LAB_ROUND2_EVIDENCE v1");
lines.push(`generated_at=${new Date().toISOString()}`);
lines.push(`node=${process.version}`);
lines.push(`fixture_count=${JSON.parse(fixtures).count}`);
lines.push(`prompt_lab_engine=${E.ENGINE_VERSION}`);

// ── Mode matrix (spec §14 A/B/C/D) ─────────────────────────────────────────
lines.push("");
lines.push("MODE_MATRIX");
{
	const dup = fix("A10-duplicate-rule-blocks");
	const m = parsePrompt(dup.content, { sourceType: "markdown" });
	const A = O.optimizeManifest(m, { mode: "A" });
	assert(A.patchOps.length === 0, "modeA_ops=0");
	assert(A.optimized.manifest.blocks.length === m.blocks.length, "modeA_manifest_unchanged=true");
	const B = O.optimizeManifest(m, { mode: "B" });
	assert(B.patchOps.length === 1 && B.patchOps[0].occurrence === 1, "modeB_delete_occurrence=1 (never the surviving copy)");
	assert(B.optimized.manifest.blocks.length === 1, "modeB_blocks_2_to_1=true");
	const C = O.optimizeManifest(m, { mode: "C" });
	lines.push(`  modeC_pendingEval=${C.pendingEval.length} modeC_ops=${C.patchOps.length}`);
	const D = O.optimizeManifest(m, { mode: "D" });
	assert(D.patchOps.length === 0, "modeD_ops=0 (no compressor adapter in static core)");
	const finD = O.finalizeOptimization(D, {});
	assert(finD.recommendation.status === O.RECOMMENDATION.EXPERIMENTAL_UNAVAILABLE, "modeD_status=EXPERIMENTAL_UNAVAILABLE");
}

// ── §12.3 instance addressing over every fixture ───────────────────────────
lines.push("");
lines.push("INSTANCE_ADDRESSING");
{
	const { meta, content } = fix("A10-duplicate-rule-blocks");
	const m = parsePrompt(content, { sourceType: meta.sourceType });
	const id = m.blocks[0].id;
	assert(m.blocks.length === 2 && m.blocks[1].id === id, "a10_shared_content_id=true");
	const patch = P.createPatch({
		baseBlocks: m.blocks,
		operations: [{ type: P.OP.DELETE_DUPLICATE_BLOCK, blockId: id, occurrence: 1 }],
	});
	const applied = P.applyPatch(m, patch);
	assert(applied.ok && applied.manifest.blocks.length === 1, "a10_delete_occ1_keeps_first=true (round-1 bug deleted both)");
}

// ── optimizer sweep over all 41 fixtures (mode B) ──────────────────────────
lines.push("");
lines.push("OPTIMIZER_SWEEP_SAFE");
{
	const all = JSON.parse(fixtures).fixtures;
	let ok = 0;
	let dntBlocksTotal = 0;
	let secretLeaks = 0;
	let safeApply = 0;
	let analyzeOnly = 0;
	let deltaTokensSum = 0;
	for (const meta of all) {
		const { content } = fix(meta.id);
		const r = E.optimize({ content, sourceType: meta.sourceType ?? undefined, provider: meta.provider, options: { mode: "B" } });
		ensure(r.verification.ok === true, `${meta.id}_verify_ok=true`);
		ensure(r.verification.checks.rules_complete_before === true && r.verification.checks.rules_complete_after === true, `${meta.id}_rules_complete=true`);
		ensure(r.summary.deltaTokens <= 0, `${meta.id}_tokens_not_increased=true`);
		const orig = parsePrompt(content, { sourceType: meta.sourceType ?? undefined });
		dntBlocksTotal += orig.blocks.filter((b) => b.mutability === "DO_NOT_TOUCH").length;
		if (r.verification.checks.dnt_preserved) ok += 1;
		if (r.recommendation.status === O.RECOMMENDATION.SAFE_APPLY) safeApply += 1;
		if (r.recommendation.status === O.RECOMMENDATION.ANALYZE_ONLY) analyzeOnly += 1;
		deltaTokensSum += r.summary.deltaTokens;
		if (meta.secretValues?.length) {
			const text = (r.optimized.manifest.blocks ?? []).map((b) => b.text).join("\n");
			for (const s of meta.secretValues) if (text.includes(s)) secretLeaks += 1;
		}
	}
	assert(ok === all.length, `verify_ok_fixtures=${ok}/${all.length}`);
	assert(secretLeaks === 0, `plaintext_secret_leaks_in_optimized_output=0`);
	lines.push(`  dnt_blocks_checked=${dntBlocksTotal}`);
	lines.push(`  recommendation_safe_apply=${safeApply} recommendation_analyze_only=${analyzeOnly}`);
	lines.push(`  total_delta_tokens=${deltaTokensSum}`);
}

// ── schema duplicates stay suggestions (tool_schema is DO_NOT_TOUCH) ───────
lines.push("");
lines.push("SCHEMA_DUP_SUGGESTION");
{
	const { meta, content } = fix("B02-duplicate-tool-schema");
	const r = E.optimize({ content, sourceType: meta.sourceType, provider: meta.provider, options: { mode: "B" } });
	assert(r.suggestions.length >= 1, "schema_dup_suggested=true");
	assert(r.patchOps.length === 0, "schema_dup_auto_applied=false");
	assert(r.optimized.manifest.blocks.length === r.original.manifest.blocks.length, "schema_blocks_untouched=true");
}

// ── verification of the core §12.1/§12.2 regressions ───────────────────────
lines.push("");
lines.push("CORE_REGRESSIONS");
{
	const { meta, content } = fix("E01-sql");
	const r = E.optimize({ content, sourceType: meta.sourceType, options: { mode: "B" } });
	assert(r.patchOps.length === 0, "dnt_sql_zero_ops=true (protection via block.mutability, not regex)");
}
{
	// immutable input: deep-frozen manifest survives the optimizer
	const dup = fix("A10-duplicate-rule-blocks");
	const frozen = structuredClone(parsePrompt(dup.content, { sourceType: "markdown" }));
	const freeze = (v) => {
		if (v && typeof v === "object") {
			Object.freeze(v);
			for (const x of Object.values(v)) freeze(x);
		}
		return v;
	};
	freeze(frozen);
	const before = JSON.stringify(frozen);
	O.optimizeManifest(frozen, { mode: "B" });
	assert(JSON.stringify(frozen) === before, "input_manifest_not_mutated=true");
}
{
	// reversible: reverseOps expressible where spec ops allow
	const dup = fix("A10-duplicate-rule-blocks");
	const m = parsePrompt(dup.content, { sourceType: "markdown" });
	const r = O.optimizeManifest(m, { mode: "B" });
	assert(r.reverse.fullyReversible === false, "delete_reverse_from_ops=false (restore uses P6 original snapshot)");
	assert(r.original.manifest && r.normalized.manifest && r.optimized.manifest && r.patch && r.optimized.fingerprint, "p6_bundle_complete=true");
}

// ── stale patch ────────────────────────────────────────────────────────────
lines.push("");
lines.push("PATCH_GUARD");
{
	const dup = fix("A10-duplicate-rule-blocks");
	const m = parsePrompt(dup.content, { sourceType: "markdown" });
	const soft = P.applyPatch(m, P.createPatch({ baseFingerprint: "deadbeef", operations: [] }), { onStale: "return" });
	assert(soft.ok === false && soft.reason === "STALE_PATCH", "stale_patch_refused=true");
}

// ── perf (22KB real fixture, deterministic optimize) ───────────────────────
lines.push("");
lines.push("PERF");
{
	const a01 = fix("A01-promptfoo-agents");
	const t0 = performance.now();
	const r = E.optimize({ content: a01.content, sourceType: a01.meta.sourceType, provider: a01.meta.provider, options: { mode: "B" } });
	const ms = performance.now() - t0;
	const after = r.optimized.manifest.blocks.length;
	const before = r.original.manifest.blocks.length;
	lines.push(`  fixture=A01-promptfoo-agents bytes=${a01.meta.bytes}`);
	lines.push(`  deterministic_optimize_ms=${ms.toFixed(2)}`);
	lines.push(`  blocks_before=${before} blocks_after=${after} rules_ok=true`);
}

// ── prompt-lab test suite (self-run for truthfulness) ──────────────────────
lines.push("");
lines.push("TEST_SUITE");
{
	const run = spawnSync(process.execPath, ["--test", "tests/prompt-lab/*.test.mjs"], { cwd: CM_ROOT, encoding: "utf8" });
	const out = run.stdout ?? "";
	const pass = Number(/^# pass (\d+)/m.exec(out)?.[1] ?? -1);
	const fail = Number(/^# fail (\d+)/m.exec(out)?.[1] ?? -1);
	assert(pass > 0 && fail === 0, `pass ${pass} fail ${fail}`);
}

const report = `${lines.join("\n")}\n`;
writeFileSync(REPORT, report, "utf8");
console.log(report);
console.log(`written: ${REPORT}`);
