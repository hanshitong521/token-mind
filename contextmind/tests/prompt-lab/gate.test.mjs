/**
 * Publish gate (spec §17.6) — round-1 gate #10/#11/#12.
 *
 * The regression: `token_not_increased` was hardcoded to `true` and
 * `critical_assertions_pass` did not exist, so a run in which ZERO rules
 * executed still returned `recommendable: true`.
 *
 * Invariant: unmeasured is UNKNOWN, and an UNKNOWN critical check blocks
 * promotion. There is no path from "we did not check" to "ship it".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, scoreManifest, VERDICT, CRITICAL_CHECKS, gateAllowsPromotion } from "../../lib/prompt-engine/scoring.mjs";
import { parsePrompt } from "../../lib/prompt-engine/parser.mjs";
import { runRulesWithReport, createFinding } from "../../lib/prompt-engine/rule-engine.mjs";
import { analyze } from "../../lib/prompt-engine/index.mjs";
import { allRules } from "../../lib/prompt-engine/index.mjs";
import { loadFixtures } from "./_helpers.mjs";

const { PASS, FAIL, UNKNOWN } = VERDICT;

function scores(over = {}) {
	return {
		quality: { score: 80, dimensions: {} },
		cache: { score: 80, dimensions: {} },
		risk: { score: 10 },
		...over,
	};
}
const goodRisk = { score: 10 };
const badRisk = { score: 95 };
const cleanExecution = { total: 11, executed: 11, failed: 0, malformed: 0, complete: true };
const brokenExecution = { total: 11, executed: 10, failed: 1, malformed: 0, complete: false };

test("every gate check is one of PASS / FAIL / UNKNOWN — no booleans, no defaults", () => {
	for (const { meta, content } of loadFixtures()) {
		const r = analyze({ content, sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		for (const [name, v] of Object.entries(r.gate.checks)) {
			assert.ok([PASS, FAIL, UNKNOWN].includes(v), `${meta.id}: check ${name} is ${v}`);
		}
	}
});

test("token_not_increased is UNKNOWN when either side is unmeasured", () => {
	const g = evaluateGate({ quality: scores().quality, cache: scores().cache, risk: goodRisk, ruleExecution: cleanExecution });
	assert.equal(g.checks.token_not_increased, UNKNOWN, "unmeasured token delta claimed a verdict");
	const g2 = evaluateGate({
		quality: scores().quality,
		cache: scores().cache,
		risk: goodRisk,
		ruleExecution: cleanExecution,
		baseline: { scores: { quality: 80, cacheStability: 80 } },
	});
	assert.equal(g2.checks.token_not_increased, UNKNOWN, "baseline without token counts claimed a verdict");
});

test("token_not_increased is measured when both sides are known", () => {
	const base = { scores: { quality: 80, cacheStability: 80 }, tokens: 1000 };
	const grew = evaluateGate({ quality: scores().quality, cache: scores().cache, risk: goodRisk, ruleExecution: cleanExecution, baseline: base, tokensAfter: 1200 });
	assert.equal(grew.checks.token_not_increased, FAIL);
	const shrank = evaluateGate({ quality: scores().quality, cache: scores().cache, risk: goodRisk, ruleExecution: cleanExecution, baseline: base, tokensAfter: 800 });
	assert.equal(shrank.checks.token_not_increased, PASS);
});

test("critical_assertions_pass is UNKNOWN when no Eval was run, and that blocks promotion", () => {
	const g = evaluateGate({ quality: scores().quality, cache: scores().cache, risk: goodRisk, ruleExecution: cleanExecution });
	assert.equal(g.checks.critical_assertions_pass, UNKNOWN, "missing Eval defaulted to a verdict");
	assert.equal(g.recommendable, false);
	assert.ok(g.blocking.includes("critical_assertions_pass"));
});

test("critical_assertions_pass reflects the supplied assertion result", () => {
	const pass = evaluateGate({ quality: scores().quality, cache: scores().cache, risk: goodRisk, ruleExecution: cleanExecution, assertions: { pass: true } });
	assert.equal(pass.checks.critical_assertions_pass, PASS);
	const fail = evaluateGate({ quality: scores().quality, cache: scores().cache, risk: goodRisk, ruleExecution: cleanExecution, assertions: { pass: false } });
	assert.equal(fail.checks.critical_assertions_pass, FAIL);
	assert.equal(fail.recommendable, false);
});

test("a broken rule blocks promotion (no recommend on zero executed rules)", () => {
	const g = evaluateGate({ quality: scores().quality, cache: scores().cache, risk: goodRisk, ruleExecution: brokenExecution, assertions: { pass: true } });
	assert.equal(g.checks.rule_execution_complete, FAIL);
	assert.equal(g.recommendable, false, "gate cleared while a rule was broken");
});

test("a missing rule execution report is UNKNOWN, and UNKNOWN blocks promotion", () => {
	const g = evaluateGate({ quality: scores().quality, cache: scores().cache, risk: goodRisk, ruleExecution: null, assertions: { pass: true } });
	assert.equal(g.checks.rule_execution_complete, UNKNOWN);
	assert.equal(g.recommendable, false);
});

test("safety regression is UNKNOWN when it rests on broken findings", () => {
	const g = evaluateGate({ quality: scores().quality, cache: scores().cache, risk: goodRisk, ruleExecution: brokenExecution });
	assert.equal(g.checks.safety_regression_zero, UNKNOWN, "risk computed from broken findings presented as a measurement");
});

test("recommendable requires every critical check to PASS and no check to FAIL", () => {
	const g = evaluateGate({
		quality: scores().quality,
		cache: scores().cache,
		risk: goodRisk,
		ruleExecution: cleanExecution,
		assertions: { pass: true },
		baseline: { scores: { quality: 80, cacheStability: 80 }, tokens: 1000 },
		tokensAfter: 900,
	});
	for (const c of CRITICAL_CHECKS) assert.equal(g.checks[c], PASS, `${c} not PASS`);
	assert.equal(g.recommendable, true);
	assert.equal(gateAllowsPromotion(g), true);
});

test("any single FAIL blocks promotion even when criticals pass", () => {
	const g = evaluateGate({
		quality: scores().quality,
		cache: scores().cache,
		risk: badRisk,
		ruleExecution: cleanExecution,
		assertions: { pass: true },
	});
	assert.equal(g.checks.safety_regression_zero, FAIL);
	assert.equal(g.recommendable, false);
});

test("no fixture is recommended without evidence", () => {
	for (const { meta, content } of loadFixtures()) {
		const r = analyze({ content, sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		// static analysis alone never has Eval evidence, so nothing may be promotable
		assert.equal(r.gate.recommendable, false, `${meta.id}: gate cleared without any Eval evidence`);
		assert.equal(r.gate.checks.critical_assertions_pass, UNKNOWN);
	}
});

test("scoreManifest threads rule execution into the gate", () => {
	const manifest = parsePrompt("# Rules\n\n- be deterministic\n", { sourceType: "markdown" });
	const { report } = runRulesWithReport(manifest, allRules(), {});
	const withReport = scoreManifest(manifest, [], { ruleExecution: report });
	assert.equal(withReport.gate.checks.rule_execution_complete, PASS);
	assert.ok(CRITICAL_CHECKS.includes("rule_execution_complete"));
	const withoutReport = scoreManifest(manifest, [], {});
	assert.equal(withoutReport.gate.checks.rule_execution_complete, UNKNOWN);
	assert.equal(withoutReport.gate.recommendable, false);
});

test("CRITICAL findings raise the risk score and can fail the safety check", () => {
	const manifest = parsePrompt("# Rules\n\n- be deterministic\n", { sourceType: "markdown" });
	const { report } = runRulesWithReport(manifest, allRules(), {});
	const critical = [createFinding({ ruleId: "SAFE-002", title: "secret", category: "RISK", severity: "CRITICAL" })];
	const clean = scoreManifest(manifest, [], { ruleExecution: report });
	const dirty = scoreManifest(manifest, critical, { ruleExecution: report });
	assert.ok(dirty.scores.risk > clean.scores.risk, "a CRITICAL finding did not raise risk");
});

test("gate reasons explain every non-PASS check", () => {
	const g = evaluateGate({ quality: scores().quality, cache: scores().cache, risk: badRisk, ruleExecution: brokenExecution });
	assert.ok(g.reasons.length >= 2, "gate did not explain itself");
	assert.ok(g.note.length > 0);
});
