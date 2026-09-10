/**
 * Round-4 machine evidence collector (Step 9 Builtin Eval + Step 10
 * Conservative Rewrite adapter + Step 11 Export family; ADR-0013).
 *
 * Self-checking: every assertion failure throws → non-zero exit. Output is
 * written to docs/reports/prompt-lab-round4-evidence.txt.
 *
 *   node contextmind/scripts/prompt-lab-round4-evidence.mjs
 */

import { writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { parsePrompt } from "../lib/prompt-engine/parser.mjs";
import { PromptLabStore } from "../lib/prompt-lab/store.mjs";
import * as API from "../lib/prompt-lab/api.mjs";
import { runBuiltinEval, BUILTIN_CASES, BUILTIN_DATASET_ID, EVAL_PROVIDERS } from "../lib/prompt-lab/eval.mjs";
import { conservativeRewriteCandidates, mergeTexts, MERGE_SIMILARITY_FLOOR } from "../lib/prompt-engine/rewrite-adapter.mjs";

const CM_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(CM_ROOT, "fixtures/prompt-lab");
const REPORT = join(CM_ROOT, "../docs/reports/prompt-lab-round4-evidence.txt");

const lines = [];
const assert = (cond, msg) => {
	if (!cond) throw new Error(`EVIDENCE ASSERTION FAILED: ${msg}`);
	lines.push(`  ${msg}`);
};

const DUP_MD =
	"# Rules\n\n- Deterministic ordering before every request.\n- Keep the user request last.\n\n# Rules\n\n- Deterministic ordering before every request.\n- Keep the user request last.";

const NEAR_MD =
	"# Rules\n\n- Deterministic ordering before every request.\n- Keep the user request last.\n\n# Rules\n\n- Deterministic ordering before every request.\n- Keep the user request last, always.\n\n# User\n\nplease do the thing";

// ── §1 BUILTIN EVAL ENGINE (offline, deterministic, spec §27–§30) ─────────
{
	lines.push("== BUILTIN_EVAL ==");
	const r = runBuiltinEval({ mode: "optimize" });
	assert(r.ok === true, "eval_full_regression_ok=true");
	assert(r.status === "PASS", "eval_status=PASS");
	assert(r.eval_provider === EVAL_PROVIDERS.BUILTIN, "eval_provider=builtin");
	assert(r.summary.totalCases >= 44, `eval_cases_dataset3_fixtures41=${r.summary.totalCases}`);
	assert(r.summary.passedCases === r.summary.totalCases, "eval_all_cases_pass=true");
	assert(r.summary.regressionCount === 0, "eval_fixture_regression_zero=true");
	assert(r.summary.criticalAssertionVerdict === "PASS", "eval_critical_assertions=PASS");
	assert(r.dataset === BUILTIN_DATASET_ID, "eval_dataset=builtin-1");
	assert(r.metrics.assertion_pass_rate > 0.99, `eval_assertion_pass_rate=${r.metrics.assertion_pass_rate}`);
	assert(r.summary.negativeTotal >= 3, `eval_negative_controls=${r.summary.negativeTotal}`);
	assert(r.summary.negativeDetected === r.summary.negativeTotal, `eval_negative_all_detected=${r.summary.negativeDetected}/${r.summary.negativeTotal}`);
	assert(r.metrics.task_success_rate === "not_measured", "eval_llm_metric_task=not_measured");
	assert(r.metrics.hallucination_rate === "not_measured", "eval_llm_metric_hallucination=not_measured");
	assert(r.metrics.latency_ms === "not_measured" && r.metrics.cost === "not_measured", "eval_llm_metric_latency_cost=not_measured");
	assert(r.metrics.tool_selection_accuracy === "not_measured" && r.metrics.provider_cached_tokens === "not_measured", "eval_llm_metric_tool_cache=not_measured");
	// §29 offline-measurable token/cache metrics are real numbers, never fabricated
	assert(typeof r.metrics.prompt_tokens_before === "number" && r.metrics.prompt_tokens_before > 0, `eval_prompt_tokens_before=${r.metrics.prompt_tokens_before}`);
	assert(typeof r.metrics.prompt_tokens_after === "number" && r.metrics.prompt_tokens_after > 0, `eval_prompt_tokens_after=${r.metrics.prompt_tokens_after}`);
	assert(r.metrics.prompt_tokens_after <= r.metrics.prompt_tokens_before, "eval_modeB_tokens_not_increased=true");
	assert(typeof r.metrics.tool_schema_tokens === "number" && r.metrics.tool_schema_tokens >= 0, `eval_tool_schema_tokens=${r.metrics.tool_schema_tokens}`);
	assert(typeof r.metrics.stable_prefix_ratio_avg === "number" && r.metrics.stable_prefix_ratio_avg >= 0 && r.metrics.stable_prefix_ratio_avg <= 1, `eval_stable_prefix_ratio_avg=${r.metrics.stable_prefix_ratio_avg}`);
	assert(typeof r.metrics.stable_prefix_tokens_avg === "number", `eval_stable_prefix_tokens_avg=${r.metrics.stable_prefix_tokens_avg}`);
	// every builtin case declares assertions + a seed
	assert(BUILTIN_CASES.length >= 3 && BUILTIN_CASES.every((c) => c.caseId && c.seed && c.must_have?.length >= 0), "eval_dataset_stable=true");

	const one = runBuiltinEval({ caseId: "DUP-RULES-001", mode: "optimize" });
	assert(one.summary.totalCases === 1 && one.status === "PASS", "eval_single_case_pass=true");
	const fx = runBuiltinEval({ fixtureId: "E01-sql", mode: "optimize" });
	assert(fx.summary.totalCases === 1 && fx.status === "PASS", "eval_single_fixture_sql_pass=true");
	const fxCount = readdirSync(FIXTURES).filter((f) => f.endsWith(".meta.json")).length;
	assert(fxCount >= 41, `eval_fixture_meta_count=${fxCount}`);
	const cust = runBuiltinEval({ content: DUP_MD, sourceType: "markdown", mode: "optimize" });
	const custom = cust.results.find((x) => x.caseId === "CUSTOM-INPUT");
	assert(custom !== undefined && custom.assertionsPassed === custom.assertionsTotal, "eval_custom_content_asserts=true");
}

// ── §2 EVAL DB SCHEMA v2 + PERSISTENCE (consumer-driven, ADR-0008) ────────
{
	lines.push("");
	lines.push("== EVAL_DB_PERSIST ==");
	const dir = mkdtempSync(join(tmpdir(), "pl-ev4-"));
	const store = PromptLabStore.open(join(dir, "evidence.db"));
	try {
		const evalTables = ["prompt_eval_runs", "prompt_eval_cases", "prompt_eval_results"].filter((t) =>
			store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t),
		);
		assert(evalTables.length === 3, "eval_schema_tables=3/3");
		const allTables = store.db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).get().n;
		assert(allTables >= 11, `eval_schema_total_tables=${allTables}/11`);

		const ev = API.routeEvaluate(store, { content: DUP_MD, sourceType: "markdown" });
		assert(ev.ok === true && ev.runId !== undefined, "eval_run_persisted=true");
		assert(ev.summary.allPassed === true && ev.status === "PASS", "eval_run_summary_pass=true");
		const full = API.routeEvaluate(store, {});
		assert(full.ok === true && full.summary.totalCases >= 44, "eval_full_regression_persisted=true");
		assert(store.getCounters().eval_run_count >= 2, "telemetry_eval_run_count>=2");
		assert(store.getCounters().eval_regression_count === 0, "telemetry_eval_regression_zero=true");

		const list = store.listEvalRuns({ limit: 10 });
		assert(list.total >= 2 && list.runs.length >= 2, "eval_runs_list_queryable=true");
		const evRow = list.runs.find((r) => r.dataset === BUILTIN_DATASET_ID);
		assert(evRow !== undefined && evRow.allPassed === true, "eval_runs_row_allPassed=true");

		const hash = createHash("sha256").update(DUP_MD).digest("hex");
		const latest = store.latestEvalEvidence(hash);
		assert(latest !== null && latest.allPassed === true, "eval_latest_evidence_allPassed=true");
		assert(latest.negativeDetected === latest.negativeTotal, "eval_latest_evidence_negatives=true");
		assert(latest.assertionsTotal > 0 && latest.assertionsPassed === latest.assertionsTotal, "eval_latest_evidence_assertions=true");
		lines.push(`  eval_runs_total=${list.total}`);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── §3 GATE THREAD: Eval evidence flips critical_assertions UNKNOWN→PASS ──
{
	lines.push("");
	lines.push("== GATE_THREAD ==");
	const dir = mkdtempSync(join(tmpdir(), "pl-ev4gate-"));
	const store = PromptLabStore.open(join(dir, "gate.db"));
	try {
		const before = API.routeAnalyze(store, { content: DUP_MD, sourceType: "markdown" });
		assert(before.gate.checks.critical_assertions_pass === "UNKNOWN", "gate_critical_assertions_unknown_before_eval=true");
		assert(before.gate.recommendable === false, "gate_closed_without_eval=true");
		API.routeEvaluate(store, { content: DUP_MD, sourceType: "markdown" });
		const after = API.routeAnalyze(store, { content: DUP_MD, sourceType: "markdown" });
		assert(after.gate.checks.critical_assertions_pass === "PASS", "gate_critical_assertions_pass_after_eval=true");
		lines.push(`  gate_checks=${Object.entries(after.gate.checks).map(([k, v]) => `${k}=${v}`).join(",")}`);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── §4 MODE C CONSERVATIVE REWRITE adapter + P10 confirm (Step 10) ───────
{
	lines.push("");
	lines.push("== MODE_C_SEMANTIC ==");
	const m = parsePrompt(NEAR_MD, { sourceType: "markdown" });
	const cands = conservativeRewriteCandidates(m);
	assert(cands.length >= 1, `semantic_candidates_found=${cands.length}`);
	for (const c of cands) {
		assert(c.risk === "SEMANTIC_REWRITE" && c.requiresEval === true, `candidate_${c.candidateId}_risk=SEMANTIC_REWRITE`);
		assert(c.ops.length === 1 && c.ops[0].type === "MERGE_BLOCKS", `candidate_${c.candidateId}_op=MERGE_BLOCKS`);
		assert(c.tokenDelta < 0, `candidate_${c.candidateId}_tokenDelta_negative=${c.tokenDelta}`);
	}
	assert(MERGE_SIMILARITY_FLOOR > 0.5 && MERGE_SIMILARITY_FLOOR < 1, "merge_similarity_floor_conservative=true");
	assert(mergeTexts("a\nb", "b\nc").split("\n").join(",") === "a,b,c", "merge_texts_line_union=true");
	const exact = parsePrompt("# Rules\n\n- a\n- b\n\n# Rules\n\n- a\n- b\n", { sourceType: "markdown" });
	assert(conservativeRewriteCandidates(exact).length === 0, "exact_duplicates_not_semantic_candidates=true");

	const dir = mkdtempSync(join(tmpdir(), "pl-ev4mc-"));
	const store = PromptLabStore.open(join(dir, "mc.db"));
	try {
		const o = API.routeOptimize(store, { content: NEAR_MD, sourceType: "markdown", mode: "C" });
		assert(o.ok === true && o.mode === "CONSERVATIVE_REWRITE", "route_optimize_mode_C=true");
		assert(Array.isArray(o.pendingEval) && o.pendingEval.length >= 1, `mode_c_pending_eval=${o.pendingEval.length}`);
		assert(o.pendingEval.every((p) => p.requiresEval === true && p.risk === "SEMANTIC_REWRITE"), "mode_c_candidates_require_eval=true");

		// candidate rows are persisted as pending patches (audit trail)
		const pend = store.patchesOf(o.version.versionId).filter((p) => p.patch_risk === "SEMANTIC_REWRITE" && p.applied === 0);
		assert(pend.length >= 1, `pending_semantic_patch_rows=${pend.length}`);
		const baseBlockCount = store.manifestOf(o.version.versionId).blocks.length;

		// P10: no Eval → blocked
		const blocked = API.routeConfirmSemantic(store, { versionId: o.version.versionId });
		assert(blocked.ok === false && /P10/.test(blocked.error ?? ""), "p10_blocks_without_eval=true");

		// all-passing Eval over the SAME content (source_hash identity) → allowed
		const ev = API.routeEvaluate(store, { content: NEAR_MD, sourceType: "markdown" });
		assert(ev.ok === true && ev.status === "PASS", "mode_c_eval_evidence_pass=true");
		const conf = API.routeConfirmSemantic(store, { versionId: o.version.versionId });
		assert(conf.ok === true, "semantic_confirm_ok=true");
		assert(conf.risk === "SEMANTIC_REWRITE", "semantic_confirm_risk=SEMANTIC_REWRITE");
		assert(conf.childVersionId !== undefined, "semantic_confirm_child_version=true");
		const childBlocks = conf.detail.blocks.length;
		assert(childBlocks === baseBlockCount - 1, `semantic_confirm_merged_blocks=${baseBlockCount}->${childBlocks}`);
		assert(store.getCounters().semantic_patch_count >= 1, "telemetry_semantic_patch>=1");

		// undo restores the full original text
		const undo = API.routePatchReverse(store, { versionId: conf.childVersionId });
		assert(undo.ok === true, "semantic_confirm_undo_ok=true");
		assert(undo.detail.blocks.length === baseBlockCount, "semantic_undo_restores_block_count=true");
		assert(store.getCounters().patch_reverse_count === 1, "telemetry_patch_reverse=1");
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── §5 STEP 11 EXPORT family (§50 file targets + JSON formats) ───────────
{
	lines.push("");
	lines.push("== STEP11_EXPORT ==");
	const targets = [
		["AGENTS", "AGENTS.md"],
		["CLAUDE", "CLAUDE.md"],
		["RULES", ".cursor/rules/prompt-lab.mdc"],
		["SKILL", "SKILL.md"],
	];
	for (const [t, filename] of targets) {
		const e = API.routeExport(null, { content: NEAR_MD, sourceType: "markdown", format: "file", target: t });
		assert(e.ok === true && e.filename === filename, `export_${t.toLowerCase()}_filename=${filename}`);
		assert(/generated by Token-Mind/.test(e.text) || /^---/.test(e.text), `export_${t.toLowerCase()}_header=true`);
		assert(e.text.includes("Deterministic ordering before every request."), `export_${t.toLowerCase()}_body_intact=true`);
	}
	const bad = API.routeExport(null, { content: NEAR_MD, sourceType: "markdown", format: "file", target: "BOGUS" });
	assert(bad.ok === false, "export_unknown_target_rejected=true");
	const oai = API.routeExport(null, { content: NEAR_MD, sourceType: "markdown", format: "openai_json" });
	assert(oai.ok === true && Array.isArray(oai.json) && oai.filename === "openai-messages.json", "export_openai_json=true");
	const ant = API.routeExport(null, { content: NEAR_MD, sourceType: "markdown", format: "anthropic_json" });
	assert(ant.ok === true && ant.json && ant.json.system !== undefined && ant.filename === "anthropic-request.json", "export_anthropic_json=true");
	const md = API.routeExport(null, { content: NEAR_MD, sourceType: "markdown", format: "markdown" });
	assert(md.ok === true && md.text.includes("please do the thing"), "export_markdown_legacy_intact=true");
}

// ── §6 LAB INFO (provider state honest) ───────────────────────────────────
{
	lines.push("");
	lines.push("== LAB_INFO ==");
	const info = API.routeLabInfo(null);
	assert(info.ok === true, "lab_info_ok=true");
	assert(info.evalProvider === "builtin", "lab_info_eval_provider=builtin");
	assert(info.promptfoo === "PROMPTFOO_NOT_INSTALLED", "lab_info_promptfoo=NOT_INSTALLED");
	assert(Array.isArray(info.optimizeModes) && info.optimizeModes.join("") === "ABCD", "lab_info_modes=ABCD");
	const dir = mkdtempSync(join(tmpdir(), "pl-ev4info-"));
	const store = PromptLabStore.open(join(dir, "info.db"));
	try {
		API.routeEvaluate(store, {});
		const info2 = API.routeLabInfo(store);
		assert(info2.evalRuns >= 1 && info2.evalRegressions === 0, "lab_info_eval_run_counters=true");
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── §7 HTTP E2E (real server child) ───────────────────────────────────────
{
	lines.push("");
	lines.push("== HTTP_E2E ==");
	const dir = mkdtempSync(join(tmpdir(), "pl-ev4http-"));
	const child = spawn(process.execPath, [join(CM_ROOT, "prompt-lab-server.mjs"), dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
	const base = await new Promise((resolve, reject) => {
		let out = "";
		const t = setTimeout(() => reject(new Error(`http start timeout: ${out}`)), 15000);
		child.stdout.on("data", (c) => {
			out += c.toString();
			const mm = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/prompt-lab/);
			if (mm) {
				clearTimeout(t);
				resolve(`http://127.0.0.1:${mm[1]}`);
			}
		});
		child.on("exit", (code) => {
			clearTimeout(t);
			reject(new Error(`child exit ${code}: ${out}`));
		});
	});
	const post = async (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
	try {
		const page = await fetch(`${base}/prompt-lab`).then((r) => r.text());
		assert(page.includes("Prompt Lab") && page.includes("Eval"), "http_page_has_eval_tab=true");
		const ev = await post("/promptLab/evaluate", { content: DUP_MD, sourceType: "markdown" });
		assert(ev.ok === true && ev.eval_provider === "builtin" && ev.status === "PASS" && ev.runId, "http_evaluate_builtin_pass=true");
		const info = await post("/promptLab/info", {});
		assert(info.evalProvider === "builtin" && info.promptfoo === "PROMPTFOO_NOT_INSTALLED", "http_lab_info_states=true");
		const o = await post("/promptLab/optimize", { content: NEAR_MD, sourceType: "markdown", mode: "C" });
		assert(o.ok === true && o.pendingEval.length >= 1, "http_mode_c_pending_eval=true");
		const blocked = await post("/promptLab/semantic/confirm", { versionId: o.version.versionId });
		assert(blocked.ok === false && /P10/.test(blocked.error ?? ""), "http_p10_blocked_without_eval=true");
		const evN = await post("/promptLab/evaluate", { content: NEAR_MD, sourceType: "markdown" });
		assert(evN.ok === true && evN.status === "PASS", "http_eval_over_mode_c_input_pass=true");
		const conf = await post("/promptLab/semantic/confirm", { versionId: o.version.versionId });
		assert(conf.ok === true && conf.risk === "SEMANTIC_REWRITE", "http_semantic_confirm_after_eval=true");
		const exp = await post("/promptLab/export", { content: NEAR_MD, sourceType: "markdown", format: "file", target: "SKILL" });
		assert(exp.ok === true && exp.filename === "SKILL.md", "http_export_skill_target=true");
	} finally {
		child.kill();
		await new Promise((r) => child.on("exit", r));
		rmSync(dir, { recursive: true, force: true });
	}
}

writeFileSync(REPORT, lines.join("\n") + "\n");
console.log(`prompt-lab round-4 evidence written: ${REPORT}`);
console.log(`  sections: builtin-eval / eval-db / gate-thread / mode-c / export / lab-info / http-e2e`);
console.log(lines.filter((l) => /^  [a-z_0-9=]+(true|=\d)/.test(l)).length + " machine assertions passed");
