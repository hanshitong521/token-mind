import { test } from "node:test";
import assert from "node:assert/strict";
import { runBuiltinEval, BUILTIN_CASES, EVAL_PROVIDERS } from "../../lib/prompt-lab/eval.mjs";

const DUP_MD =
	"# Rules\n\n- Deterministic ordering before every request.\n- Keep the user request last.\n\n# Rules\n\n- Deterministic ordering before every request.\n- Keep the user request last.";

test("eval: dataset + fixture regression all pass, metrics normalized", () => {
	const r = runBuiltinEval({ mode: "optimize" });
	assert.equal(r.ok, true);
	assert.equal(r.status, "PASS");
	assert.equal(r.eval_provider, EVAL_PROVIDERS.BUILTIN);
	assert.ok(r.summary.totalCases >= 44, `dataset (3) + fixture regression (41) both run, got ${r.summary.totalCases}`);
	assert.equal(r.summary.passedCases, r.summary.totalCases);
	assert.equal(r.summary.regressionCount, 0);
	assert.equal(r.summary.negativeDetected, r.summary.negativeTotal);
	assert.ok(r.metrics.assertion_pass_rate > 0.99, "assertion pass rate ≈1");
	// LLM-only metrics are honest "not_measured", never fabricated
	assert.equal(r.metrics.task_success_rate, "not_measured");
	assert.equal(r.metrics.hallucination_rate, "not_measured");
	assert.equal(r.metrics.latency_ms, "not_measured");
	assert.equal(r.metrics.cost, "not_measured");
});

test("eval: custom content runs as an ad-hoc case with assertions", () => {
	const r = runBuiltinEval({ content: DUP_MD, sourceType: "markdown", mode: "optimize" });
	assert.equal(r.ok, true);
	const custom = r.results.find((x) => x.caseId === "CUSTOM-INPUT");
	assert.ok(custom, "custom case present");
	assert.equal(custom.assertionsPassed, custom.assertionsTotal);
});

test("eval: negative controls are statically detected (volatile/dup injections)", () => {
	const r = runBuiltinEval({ mode: "optimize" });
	assert.ok(r.summary.negativeTotal >= 3, "dataset declares ≥3 negative controls");
	assert.equal(r.summary.negativeDetected, r.summary.negativeTotal, "every injected defect is caught");
});

test("eval: single builtin case + single fixture regression", () => {
	const one = runBuiltinEval({ caseId: "DUP-RULES-001", mode: "optimize" });
	assert.equal(one.summary.totalCases, 1);
	assert.equal(one.status, "PASS");
	const fx = runBuiltinEval({ fixtureId: "E01-sql", mode: "optimize" });
	assert.equal(fx.summary.totalCases, 1);
	assert.equal(fx.status, "PASS", "E01 sql DO_NOT_TOUCH regression green");
});

test("eval: dataset is stable, every case declares assertions", () => {
	assert.ok(Array.isArray(BUILTIN_CASES) && BUILTIN_CASES.length >= 3);
	for (const c of BUILTIN_CASES) {
		assert.ok(c.caseId && c.seed, "case id + seed present");
		assert.ok(Array.isArray(c.must_have) && Array.isArray(c.must_not_have), "assertions declared");
	}
});
