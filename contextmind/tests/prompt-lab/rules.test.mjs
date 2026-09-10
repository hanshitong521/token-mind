/**
 * Rule execution (round-1 gate #1, #11).
 *
 * The condition this exists to catch: `runRules` calling `rule(manifest)` on a
 * `{id, run}` descriptor. Every rule threw, every throw was swallowed into an
 * INFO placeholder, and the engine reported a clean, recommendable result on
 * the basis of zero executed rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, allRules } from "../../lib/prompt-engine/index.mjs";
import { runRulesWithReport, normalizeRule, createFinding } from "../../lib/prompt-engine/rule-engine.mjs";
import { parsePrompt } from "../../lib/prompt-engine/parser.mjs";
import { loadFixtures } from "./_helpers.mjs";

test("every registered rule is invocable", () => {
	const rules = allRules();
	assert.ok(rules.length >= 10, `only ${rules.length} rules registered`);
	for (const r of rules) {
		assert.ok(normalizeRule(r), `rule ${r?.id} has no callable run()`);
		assert.equal(typeof normalizeRule(r).run, "function");
	}
});

test("all rules execute cleanly on every fixture (100% execution rate)", () => {
	for (const { meta, content } of loadFixtures()) {
		const r = analyze({ content, sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		const rep = r.ruleExecution;
		assert.equal(rep.failed, 0, `${meta.id}: ${rep.failed} rule(s) threw: ${JSON.stringify(rep.errors)}`);
		assert.equal(rep.malformed, 0, `${meta.id}: ${rep.malformed} malformed rule(s)`);
		assert.equal(rep.executed, rep.total, `${meta.id}: executed ${rep.executed}/${rep.total}`);
		assert.equal(rep.complete, true, `${meta.id}: rule execution incomplete`);
	}
});

test("no finding is ever a swallowed rule exception", () => {
	for (const { meta, content } of loadFixtures()) {
		const r = analyze({ content, sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		for (const f of r.findings) {
			assert.notEqual(f.ruleId, "RULE_ERROR", `${meta.id}: a rule threw and was turned into a finding`);
			assert.ok(!/threw while running/.test(f.title ?? ""), `${meta.id}: swallowed exception in findings`);
		}
	}
});

test("a throwing rule is reported CRITICAL and breaks execution completeness", () => {
	const broken = [{ id: "BOOM", title: "boom", category: "QUALITY", severity: "HIGH", run() { throw new Error("deliberate"); } }];
	const m = parsePrompt("# Rules\n\n- be deterministic\n", { sourceType: "markdown" });
	const { findings, report } = runRulesWithReport(m, broken, {});
	assert.equal(report.failed, 1);
	assert.equal(report.complete, false);
	const errorFinding = findings.find((f) => f.ruleId === "RULE_ERROR");
	assert.ok(errorFinding, "a thrown rule must surface as a RULE_ERROR finding");
	assert.equal(errorFinding.severity, "CRITICAL", "a broken rule is not an INFO matter");
	assert.equal(errorFinding.requiresEval, true);
});

test("a rule without run() is reported as malformed, not silently skipped", () => {
	const broken = [{ id: "NO_RUN", title: "no run", category: "QUALITY" }];
	const m = parsePrompt("# Rules\n\n- be deterministic\n", { sourceType: "markdown" });
	const { report } = runRulesWithReport(m, broken, {});
	assert.equal(report.malformed, 1);
	assert.equal(report.executed, 0);
	assert.equal(report.complete, false);
});

test("a rule returning a non-array is a failure, not an empty result", () => {
	const broken = [{ id: "BAD_RETURN", run: () => ({ not: "an array" }) }];
	const m = parsePrompt("# Rules\n\n- be deterministic\n", { sourceType: "markdown" });
	const { report } = runRulesWithReport(m, broken, {});
	assert.equal(report.failed, 1);
	assert.equal(report.complete, false);
});

test("bare functions are still accepted as rules", () => {
	const fn = function myRule() {
		return [createFinding({ ruleId: "X", title: "t", category: "QUALITY" })];
	};
	const m = parsePrompt("# Rules\n\n- be deterministic\n", { sourceType: "markdown" });
	const { findings, report } = runRulesWithReport(m, [fn], {});
	assert.equal(report.executed, 1);
	assert.equal(findings.length, 1);
});

test("fixture-declared expected rules actually fire", () => {
	let checked = 0;
	for (const { meta, content } of loadFixtures()) {
		const expected = meta.expect?.ruleIds ?? [];
		if (expected.length === 0) continue;
		const r = analyze({ content, sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		for (const ruleId of expected) {
			checked += 1;
			assert.ok(
				r.findings.some((f) => f.ruleId === ruleId),
				`${meta.id}: expected rule ${ruleId}, got [${r.findings.map((f) => f.ruleId).join(",")}]`,
			);
		}
	}
	assert.ok(checked >= 8, `only ${checked} rule expectations were exercised`);
});

test("Q13 is implemented, not an empty placeholder", () => {
	const m = parsePrompt("# Rules\n\n- 当前任务：把 parser 的分类逻辑补完\n- 保持确定性\n", { sourceType: "markdown" });
	const { findings } = runRulesWithReport(m, allRules(), {});
	assert.ok(findings.some((f) => f.ruleId === "Q13"), "Q13 produced no finding for an obvious dynamic-in-static case");
});

test("findings carry the traceability fields required by spec §25", () => {
	const { meta, content } = loadFixtures().find((f) => f.meta.id === "D01-timestamp-prefix");
	const r = analyze({ content, sourceType: meta.sourceType, provider: meta.provider });
	for (const f of r.findings) {
		assert.ok(f.ruleId, "finding without ruleId");
		assert.ok(f.title, "finding without title");
		assert.ok(["QUALITY", "CACHE", "TOKEN", "DETERMINISM", "RISK"].includes(f.category), `bad category ${f.category}`);
		assert.ok(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(f.severity), `bad severity ${f.severity}`);
		assert.ok(Array.isArray(f.blockIds), "finding without blockIds");
		assert.equal(typeof f.requiresEval, "boolean");
		assert.equal(typeof f.autoApplicable, "boolean");
	}
});

test("every finding resolves to real block ids in the analyzed manifest", () => {
	for (const { meta, content } of loadFixtures()) {
		const r = analyze({ content, sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		const ids = new Set(r.manifest.blocks.map((b) => b.id));
		for (const f of r.findings) {
			for (const id of f.blockIds) assert.ok(ids.has(id), `${meta.id}: finding ${f.ruleId} points at unknown block ${id}`);
		}
	}
});
