/**
 * Round-3 machine evidence collector (Step 8 UI/路由/DB + §16 Layout Engine).
 *
 * Self-checking: every assertion failure throws → non-zero exit. Output is
 * written to docs/reports/prompt-lab-round3-evidence.txt.
 *
 *   node contextmind/scripts/prompt-lab-round3-evidence.mjs
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parsePrompt } from "../lib/prompt-engine/parser.mjs";
import { layoutBundle, LAYOUT_RULE_ID } from "../lib/prompt-engine/layout.mjs";
import { PromptLabStore } from "../lib/prompt-lab/store.mjs";
import * as API from "../lib/prompt-lab/api.mjs";

const CM_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(CM_ROOT, "fixtures/prompt-lab");
const REPORT = join(CM_ROOT, "../docs/reports/prompt-lab-round3-evidence.txt");

const lines = [];
const assert = (cond, msg) => {
	if (!cond) throw new Error(`EVIDENCE ASSERTION FAILED: ${msg}`);
	lines.push(`  ${msg}`);
};

function fixtures() {
	return readdirSync(FIXTURES).filter((f) => f.endsWith(".meta.json")).sort().map((f) => {
		const meta = JSON.parse(readFileSync(join(FIXTURES, f), "utf8"));
		return { meta, content: readFileSync(join(FIXTURES, meta.file), "utf8") };
	});
}

const DYN_MD = [
	"# Rules",
	"",
	"- Current task: implement checkout.",
	"- Today is 2026-09-09, keep going.",
	"",
	"# Project Context",
	"",
	"The codebase uses a layered layout with deterministic ordering.",
	"",
	"# Build Notes",
	"",
	"Run tests before every commit.",
].join("\n");

// ── §1 LAYOUT ENGINE ───────────────────────────────────────────────────────
{
	lines.push("== LAYOUT_ENGINE ==");
	const m = parsePrompt(DYN_MD, { sourceType: "markdown" });
	const bundle = layoutBundle(m);
	const report = bundle.report;
	assert(report.lanes.length === 8, "lanes_l0_l7=8");
	assert(report.lanes[0].label === "L0 PROVIDER / SYSTEM" && report.lanes[7].label === "L7 CURRENT USER REQUEST", "lane_labels_match_spec16");
	assert(report.frontier !== null && report.frontier.index === 0, "frontier_is_first_dynamic=true");
	const movable = report.violations.find((v) => v.ruleId === LAYOUT_RULE_ID && v.movable);
	assert(movable !== undefined && movable.kind === "project_contract", "safe_reorder_after_frontier_detected=true");
	const manual = report.violations.find((v) => v.ruleId === LAYOUT_RULE_ID && !v.movable);
	assert(manual !== undefined && /sequence-sensitive/.test(manual.why), "safe_compact_after_frontier_reported_manual=true");
	assert(bundle.moves.candidates.length === 1, "move_candidates_only_safe_reorder=true");
	assert(bundle.moves.candidates[0].autoApplicable === false, "layout_moves_never_auto=true");

	const full = parsePrompt("# System\n\nBe helpful.\n\n# Project Context\n\nStatic repo map A.\n", { sourceType: "markdown" });
	const rf = layoutBundle(full).report;
	assert(rf.frontier === null && rf.violations.length === 0, "fully_static_zero_violations=true");

	let total = 0;
	for (const { meta, content } of fixtures()) {
		const man = parsePrompt(content, { sourceType: meta.sourceType ?? "markdown" });
		const r = layoutBundle(man).report;
		const laneCount = r.lanes.reduce((a, l) => a + l.blockCount, 0);
		assert(laneCount === r.order.length, `${meta.id}_layout_no_throw_lane_agg=true`);
		total += 1;
	}
	lines.push(`  fixtures_layout_scanned=${total}`);
}

// ── §2 DB + STORE ──────────────────────────────────────────────────────────
{
	lines.push("");
	lines.push("== DB_STORE ==");
	const dir = mkdtempSync(join(tmpdir(), "pl-ev3-"));
	const store = PromptLabStore.open(join(dir, "evidence.db"));
	try {
		assert(store.ready === true, "schema_ensure=true");
		const prov = store.listProviderCapabilities();
		assert(prov.length >= 6, `provider_registry_seeded=${prov.length}`);
		const counters0 = store.getCounters();
		assert(Object.values(counters0).every((n) => n === 0), "telemetry_starts_zero=true");

		const s = readFileSync(join(FIXTURES, "A10-duplicate-rule-blocks.md"), "utf8");
		const m = parsePrompt(s, { sourceType: "markdown" });
		const v1 = store.saveVersion({ content: s, manifest: m, kind: "analyze", scores: { quality: 50 }, sourceType: "markdown", fingerprint: { root: "fp1", segments: {} } });
		assert(v1.version_no === 1, "version_no_sequence=1");
		const doc = store.db.prepare(`SELECT id FROM prompt_documents WHERE id=?`).get(v1.document_id);
		assert(doc !== undefined, "document_persisted=true");
		assert(store.historyList({}).total === 1, "history_list_versions=1");

		const counts = new Map();
		let dupId = null;
		for (const b of m.blocks) {
			const n = (counts.get(b.id) ?? 0) + 1;
			counts.set(b.id, n);
			if (n === 2) { dupId = b.id; break; }
		}
		const before = store.manifestOf(v1.id).blocks.length;
		const ap = store.acceptPatch(v1.id, [{ type: "DELETE_DUPLICATE_BLOCK", blockId: dupId, occurrence: 1 }]);
		assert(ap.ok === true, "patch_apply_single_op_ok=true");
		assert(store.manifestOf(ap.childVersionId).blocks.length === before - 1, "patch_apply_removes_exact_copy=true");
		assert(store.getCounters().patch_apply_count === 1, "telemetry_patch_apply=1");
		const undo = store.undoToParent(ap.childVersionId);
		assert(undo.ok === true, "patch_reverse_snapshot_ok=true");
		assert(store.getCounters().patch_reverse_count === 1, "telemetry_patch_reverse=1");
		const rej = store.acceptPatch(v1.id, [{ type: "DELETE_DUPLICATE_BLOCK", blockId: "no-such", occurrence: 0 }]);
		assert(rej.ok === false && store.getCounters().patch_rejected_count === 1, "stale_op_rejected=true");
		assert(store.historyList({}).total === 3, "history_versions_chain=3");
		lines.push(`  schema_tables=${["prompt_meta", "prompt_documents", "prompt_versions", "prompt_blocks", "prompt_findings", "prompt_patches", "prompt_fingerprints", "provider_capabilities"].filter((t) => store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t)).length}/8`);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── §3 API ROUTES (pure handlers, temp store) ──────────────────────────────
{
	lines.push("");
	lines.push("== API_ROUTES ==");
	const dir = mkdtempSync(join(tmpdir(), "pl-ev3api-"));
	const store = PromptLabStore.open(join(dir, "api.db"));
	try {
		const a10 = fixtures().find((f) => f.meta.id === "A10-duplicate-rule-blocks");
		const r = API.routeAnalyze(store, { content: a10.content, sourceType: "markdown", title: "A10" });
		assert(r.ok === true && r.version.versionNo === 1, "route_analyze_ok=true");
		assert(r.findings.some((f) => f.ruleId === "Q04-DUP-EXACT"), "route_analyze_findings_dup=true");
		assert(store.getCounters().analyze_count === 1, "telemetry_analyze=1");

		const o = API.routeOptimize(store, { content: a10.content, sourceType: "markdown", mode: "B" });
		assert(o.ok === true && o.mode === "SAFE", "route_optimize_mode_B=true");
		assert(o.patchOps.some((x) => x.type === "DELETE_DUPLICATE_BLOCK"), "route_optimize_dedup_op=true");
		assert(o.recommendation.status === "SAFE_APPLY", "route_optimize_safe_apply=true");
		assert(o.verification.ok === true, "route_optimize_verification_ok=true");
		assert(o.layout.report.lanes.length === 8 && o.layout.report.lanes.every((l) => typeof l.tokenCount === "number"), "route_optimize_layout_bundle=true");

		const e01 = fixtures().find((f) => f.meta.id === "E01-sql");
		const od = API.routeOptimize(store, { content: e01.content, sourceType: "json", mode: "B" });
		assert(od.ok === true && od.patchOps.length === 0, "route_optimize_dnt_zero_ops=true");

		const applied = API.routePatchApply(store, { versionId: r.version.versionId, ops: o.patchOps });
		assert(applied.ok === true && applied.detail.version.kind === "patch_apply", "route_patch_apply_ok=true");
		const undone = API.routePatchReverse(store, { versionId: applied.childVersionId });
		assert(undone.ok === true, "route_patch_reverse_ok=true");

		const ly = API.routeLayout(store, { content: DYN_MD });
		assert(ly.ok === true && ly.layout.moves.candidates.length === 1, "route_layout_moves=1");
		const ev = API.routeEvaluate(store, {});
		assert(ev.eval_provider === "PROMPTFOO_NOT_INSTALLED", "route_evaluate_downgrade=true");
		const caps = API.routeProviderCapabilities(store);
		assert(caps.ok === true && caps.providers.length >= 6, "route_provider_capabilities=true");
		const exp = API.routeExport(store, { content: a10.content, sourceType: "markdown", format: "markdown" });
		assert(exp.ok === true && exp.text.includes("Deterministic"), "route_export_markdown=true");
		const tk = API.routeTokenize(store, { content: a10.content });
		assert(tk.ok === true && tk.total > 0, "route_tokenize=true");
		assert(store.getCounters().optimize_count === 2, "telemetry_optimize=2");
		lines.push(`  history_versions_after_flow=${store.historyList({}).total}`);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── §4 HTTP E2E (real server child) ────────────────────────────────────────
{
	lines.push("");
	lines.push("== HTTP_E2E ==");
	const dir = mkdtempSync(join(tmpdir(), "pl-ev3http-"));
	const child = spawn(process.execPath, [join(CM_ROOT, "prompt-lab-server.mjs"), dir, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
	const base = await new Promise((resolve, reject) => {
		let out = "";
		const t = setTimeout(() => reject(new Error(`http start timeout: ${out}`)), 15000);
		child.stdout.on("data", (c) => {
			out += c.toString();
			const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/prompt-lab/);
			if (m) { clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
		});
		child.on("exit", (code) => { clearTimeout(t); reject(new Error(`child exit ${code}: ${out}`)); });
	});
	try {
		const page = await fetch(`${base}/prompt-lab`).then((r) => r.text());
		assert(page.includes("Prompt Lab") && page.includes("History"), "http_page_200=true");
		const a10 = fixtures().find((f) => f.meta.id === "A10-duplicate-rule-blocks");
		const ana = await fetch(`${base}/promptLab/analyze`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: a10.content, sourceType: "markdown" }) }).then((r) => r.json());
		assert(ana.ok === true && ana.version.versionNo === 1, "http_analyze_ok=true");
		const opt = await fetch(`${base}/promptLab/optimize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: a10.content, sourceType: "markdown", mode: "B" }) }).then((r) => r.json());
		assert(opt.ok === true && opt.patchOps.length >= 1, "http_optimize_ok=true");
		const hist = await fetch(`${base}/promptLab/history/list`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.json());
		assert(hist.ok === true && hist.total >= 2, "http_history_persisted=true");
		lines.push(`  http_history_total=${hist.total}`);
	} finally {
		child.kill();
		await new Promise((r) => child.on("exit", r));
		rmSync(dir, { recursive: true, force: true });
	}
}

writeFileSync(REPORT, lines.join("\n") + "\n");
console.log(`prompt-lab round-3 evidence written: ${REPORT}`);
console.log(`  sections: layout / db-store / api / http-e2e`);
console.log(lines.filter((l) => /^  [a-z_0-9=]+(true|=\d)/.test(l)).length + " machine assertions passed");
