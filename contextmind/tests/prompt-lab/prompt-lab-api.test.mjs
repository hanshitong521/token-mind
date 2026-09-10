import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PromptLabStore } from "../../lib/prompt-lab/store.mjs";
import * as API from "../../lib/prompt-lab/api.mjs";
import { fixtureById } from "./_helpers.mjs";

const DUP_MD =
	"# Rules\n\n- Deterministic ordering before every request.\n- Keep the user request last.\n\n# Rules\n\n- Deterministic ordering before every request.\n- Keep the user request last.";

const tmp = mkdtempSync(join(tmpdir(), "pl-api-"));
const stores = [];
after(() => {
	for (const s of stores) s.close();
	rmSync(tmp, { recursive: true, force: true });
});
function store(name) {
	const s = PromptLabStore.open(join(tmp, `${name}.db`));
	stores.push(s);
	return s;
}

const A10 = fixtureById("A10-duplicate-rule-blocks");
const E01 = fixtureById("E01-sql");

const DYN_MD = [
	"# Rules",
	"",
	"- Current task: implement checkout.",
	"- Today is 2026-09-09, keep going.",
	"",
	"# Project Context",
	"",
	"The codebase uses a layered layout with deterministic ordering.",
].join("\n");

test("api analyze: full report + persisted version + telemetry", () => {
	const s = store("analyze");
	const r = API.routeAnalyze(s, { content: A10.content, sourceType: "markdown", provider: "cursor", title: "A10" });
	assert.equal(r.ok, true);
	assert.equal(r.redacted, true);
	assert.ok(r.version.versionId && r.version.versionNo === 1);
	assert.match(r.version.uri, /^prompt:\/\/doc:/);
	assert.ok(r.scores.quality >= 0 && r.scores.risk >= 0);
	assert.equal(r.findings.some((f) => f.ruleId === "Q04-DUP-EXACT"), true);
	assert.equal(r.blocks.length >= 2, true);
	assert.equal(r.gate.recommendable, false, "no Eval evidence ⇒ gate closed");
	assert.equal(s.getCounters().analyze_count, 1);
	const list = API.routeHistoryList(s, {});
	assert.equal(list.total, 1);
	const detail = API.routeHistoryDetail(s, { versionId: r.version.versionId });
	assert.equal(detail.ok, true);
	assert.equal(detail.blocks.length, r.blocks.length);
	assert.equal(detail.findings.length, r.findings.length);
});

test("api optimize: mode B dedup op + recommendation + layout + patch persisted", () => {
	const s = store("optimize");
	const r = API.routeOptimize(s, { content: A10.content, sourceType: "markdown", mode: "B", provider: "anthropic" });
	assert.equal(r.ok, true);
	assert.equal(r.mode, "SAFE");
	assert.ok(r.patchOps.length >= 1, "dedup op expected");
	assert.equal(r.patchOps[0].type, "DELETE_DUPLICATE_BLOCK");
	assert.equal(r.recommendation.status, "SAFE_APPLY");
	assert.equal(r.verification.ok, true);
	assert.equal(r.after.tokens <= r.before.tokens, true);
	// layout bundle present
	assert.equal(r.layout.report.lanes.length, 8);
	assert.ok(Array.isArray(r.layout.moves.candidates));
	// persisted as an (unapplied) patch on the original version
	assert.equal(s.getCounters().optimize_count, 1);
	const detail = API.routeHistoryDetail(s, { versionId: r.version.versionId });
	assert.ok(detail.patches.length >= 1);
	assert.equal(detail.patches.every((p) => p.applied === false), true);
});

test("api optimize: DO_NOT_TOUCH (E01 sql) yields zero ops in mode B", () => {
	const s = store("dnt");
	const r = API.routeOptimize(s, { content: E01.content, sourceType: "json", mode: "B" });
	assert.equal(r.ok, true);
	assert.equal(r.patchOps.length, 0);
	assert.equal(r.recommendation.status, "ANALYZE_ONLY");
});

test("api patch apply + reverse round trip restores identical text", () => {
	const s = store("roundtrip");
	const a = API.routeAnalyze(s, { content: A10.content, sourceType: "markdown" });
	const o = API.routeOptimize(s, { content: A10.content, sourceType: "markdown", mode: "B" });
	// apply the delete op to the stored analyze version
	const applied = API.routePatchApply(s, { versionId: a.version.versionId, ops: o.patchOps });
	assert.equal(applied.ok, true);
	const childDetail = applied.detail;
	assert.equal(childDetail.version.kind, "patch_apply");
	assert.equal(childDetail.blocks.length, a.blocks.length - o.patchOps.filter((op) => op.type === "DELETE_DUPLICATE_BLOCK").length);

	// undo restores the exact original text
	const undone = API.routePatchReverse(s, { versionId: applied.childVersionId });
	assert.equal(undone.ok, true);
	const origText = a.blocks.map((b) => b.text).join("\n");
	assert.equal(undone.detail.text, origText);
	assert.equal(s.getCounters().patch_apply_count, 1);
	assert.equal(s.getCounters().patch_reverse_count, 1);
});

test("api diff / fingerprint / tokenize / layout / provider caps", () => {
	const s = store("readonly");
	const d = API.routeDiff(s, { before: { content: "# A\n\nrule one\n" }, after: { content: "# A\n\nrule two\n" } });
	assert.equal(d.ok, true);
	assert.ok(d.diff);
	const fp = API.routeFingerprint(s, { content: "# A\n\nrule one\n" });
	assert.ok(fp.fingerprint.root);
	const tk = API.routeTokenize(s, { content: "# A\n\nrule one\n" });
	assert.ok(tk.total > 0);
	const ly = API.routeLayout(s, { content: DYN_MD });
	assert.equal(ly.ok, true);
	assert.equal(ly.layout.report.lanes.length, 8);
	const prov = API.routeProviderCapabilities(s);
	assert.ok(prov.providers.length >= 6);
});

test("api evaluate runs the builtin engine and persists evidence", () => {
	const s = store("eval");
	const r = API.routeEvaluate(s, { content: DUP_MD, sourceType: "markdown" });
	assert.equal(r.ok, true);
	assert.equal(r.eval_provider, "builtin");
	assert.equal(r.status, "PASS");
	assert.ok(r.runId, "run persisted");
	assert.ok(r.summary.totalCases >= 4, `dataset cases + custom case ran (${r.summary.totalCases})`);
	// full regression (no content) also passes → engine healthy
	const full = API.routeEvaluate(s, {});
	assert.equal(full.ok, true);
	assert.ok(full.summary.totalCases >= 44, `dataset + 41 fixtures (${full.summary.totalCases})`);
	assert.equal(full.summary.regressionCount, 0);
	// the run is queryable as gate evidence
	const ev = s.latestEvalEvidence(createHash("sha256").update(DUP_MD).digest("hex"));
	assert.ok(ev && ev.allPassed === true);
	assert.ok(s.getCounters().eval_run_count >= 2);
});

test("api analyze gate flips UNKNOWN→PASS after an all-passing eval run", () => {
	const s = store("evalgate");
	const before = API.routeAnalyze(s, { content: DUP_MD, sourceType: "markdown" });
	assert.equal(before.gate.checks.critical_assertions_pass, "UNKNOWN");
	assert.equal(before.gate.recommendable, false);
	API.routeEvaluate(s, { content: DUP_MD, sourceType: "markdown" });
	const after = API.routeAnalyze(s, { content: DUP_MD, sourceType: "markdown" });
	assert.equal(after.gate.checks.critical_assertions_pass, "PASS");
});

test("api export: markdown/messages/anthropic/patch formats", () => {
	const md = API.routeExport(null, { content: "# Rules\n\n- deterministic\n", sourceType: "markdown", format: "markdown" });
	assert.equal(md.ok, true);
	assert.match(md.text, /deterministic/);
	const msg = API.routeExport(null, {
		content: JSON.stringify({ messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }] }),
		sourceType: "openai",
		format: "messages",
	});
	assert.equal(msg.ok, true);
	assert.ok(Array.isArray(msg.json));
	const an = API.routeExport(null, { content: "# Rules\n\n- x\n", sourceType: "markdown", format: "anthropic" });
	assert.ok(an.json || an.ok);
	const patch = API.routeExport(null, { content: "# Rules\n", sourceType: "markdown", format: "patch", operations: [{ type: "MOVE_BLOCK" }] });
	assert.deepEqual(patch.json, [{ type: "MOVE_BLOCK" }]);
});

test("api import + history list filtered by doc", () => {
	const s = store("hist");
	const imp = API.routeImport(s, { content: A10.content, sourceType: "markdown", title: "dup rules" });
	assert.equal(imp.ok, true);
	assert.equal(s.getCounters().import_count, 1);
	const imp2 = API.routeImport(s, { content: A10.content, sourceType: "markdown", title: "dup rules 2" });
	assert.equal(imp2.created, false, "existing doc updated not recreated");
	API.routeAnalyze(s, { content: A10.content, sourceType: "markdown" });
	API.routeAnalyze(s, { content: DYN_MD, sourceType: "markdown" });
	const all = API.routeHistoryList(s, {});
	assert.equal(all.total, 2, "import registers a document; versions come from analyze");
	const only = API.routeHistoryList(s, { docId: imp.documentId });
	assert.equal(only.total, 1);
});
