/**
 * Finding model + rule engine plumbing.
 *
 * Prompt Lab spec §25 fixes the PromptFinding shape: every result is
 * traceable to ruleId, category, severity, and specific blockIds, and carries
 * token/cache deltas plus whether it needs eval before auto-application
 * (spec §17.6 / §P10).
 */

import { sha256 } from "./manifest.mjs";

export const CATEGORIES = Object.freeze(["QUALITY", "CACHE", "TOKEN", "DETERMINISM", "RISK"]);
export const SEVERITIES = Object.freeze(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);

/**
 * Create a finding. All fields are optional except ruleId/title/category.
 * `blockIds`, `evidence`, `proposal` get defaulted so downstream consumers
 * can render uniformly.
 */
export function createFinding({
	ruleId,
	title,
	category,
	severity = "MEDIUM",
	explanation = "",
	blockIds = [],
	evidence = [],
	proposal = null,
	estimatedTokenDelta = 0,
	estimatedCacheDelta = 0,
	requiresEval = false,
	autoApplicable = false,
	id = null,
}) {
	return {
		id: id ?? sha256(`${ruleId}\u0000${title}\u0000${JSON.stringify(blockIds)}`, 12),
		ruleId,
		severity,
		category,
		blockIds,
		title,
		explanation,
		evidence,
		proposal,
		estimatedTokenDelta,
		estimatedCacheDelta,
		requiresEval,
		autoApplicable,
	};
}

/**
 * Rule Contract (normalized here so a rule may be supplied either as a bare
 * function or as a descriptor object `{ id, title, category, severity, run }`).
 *
 * A rule that cannot be invoked is a DEFECT, never a silent no-op: it is
 * reported as a CRITICAL DETERMINISM finding and counted in the execution
 * report, so `recommendable` can never be true while rules are broken
 * (baseline integrity requirement).
 */
export function normalizeRule(rule) {
	if (typeof rule === "function") {
		return { id: rule.name || "anonymous-fn", title: rule.name || "anonymous", category: "DETERMINISM", severity: "MEDIUM", run: rule };
	}
	if (rule && typeof rule.run === "function") return rule;
	return null;
}

/**
 * Run rules and return BOTH findings and an execution report.
 *
 * `report.total` counts every rule handed in; `report.executed` counts rules
 * that actually ran and returned an array. `total === executed && failed === 0`
 * is a hard precondition for any publish gate (see scoring.evaluateGate).
 */
export function runRulesWithReport(manifest, rules, ctx = {}) {
	const findings = [];
	const report = { total: 0, executed: 0, failed: 0, malformed: 0, errors: [], perRule: [] };

	for (const raw of rules ?? []) {
		report.total += 1;
		const rule = normalizeRule(raw);
		const ruleId = rule?.id ?? raw?.id ?? "unknown";

		if (!rule) {
			report.malformed += 1;
			report.errors.push({ ruleId, message: "rule has no callable run() — not executed" });
			findings.push(
				createFinding({
					ruleId: "RULE_ERROR",
					title: `Rule ${ruleId} is malformed (no run())`,
					category: "DETERMINISM",
					severity: "CRITICAL",
					explanation:
						`Rule "${ruleId}" was registered without a callable run(). Every registered ` +
						`rule must expose run(manifest, ctx) => PromptFinding[] or be a function. ` +
						`Analysis results are not trustworthy while this is unresolved.`,
					evidence: [{ ruleId }],
					requiresEval: true,
					autoApplicable: false,
				}),
			);
			continue;
		}

		try {
			const out = rule.run(manifest, ctx);
			if (!Array.isArray(out)) {
				report.failed += 1;
				report.errors.push({ ruleId, message: `run() returned ${typeof out}, expected PromptFinding[]` });
				findings.push(
					createFinding({
						ruleId: "RULE_ERROR",
						title: `Rule ${ruleId} returned a non-array`,
						category: "DETERMINISM",
						severity: "CRITICAL",
						explanation: `Rule "${ruleId}" must return PromptFinding[]; got ${typeof out}.`,
						evidence: [{ ruleId, got: typeof out }],
						requiresEval: true,
						autoApplicable: false,
					}),
				);
				continue;
			}
			report.executed += 1;
			report.perRule.push({ ruleId, ok: true, findings: out.length });
			findings.push(...out);
		} catch (err) {
			// Fail-open per spec §P11: never crash Analyze. But a thrown rule is
			// CRITICAL, not INFO — it invalidates the score/gate downstream.
			report.failed += 1;
			const message = String(err && err.message ? err.message : err);
			report.errors.push({ ruleId, message });
			report.perRule.push({ ruleId, ok: false, error: message });
			findings.push(
				createFinding({
					ruleId: "RULE_ERROR",
					title: `Rule ${ruleId} threw while running`,
					category: "DETERMINISM",
					severity: "CRITICAL",
					explanation:
						`Rule "${ruleId}" threw: ${message}. Any score, finding count or gate ` +
						`produced while a rule is broken is not evidence.`,
					evidence: [{ ruleId, message }],
					requiresEval: true,
					autoApplicable: false,
				}),
			);
		}
	}

	report.complete = report.total > 0 && report.executed === report.total && report.failed === 0 && report.malformed === 0;
	return { findings, report };
}

/** Back-compatible single-value entry: findings only. */
export function runRules(manifest, rules, ctx = {}) {
	return runRulesWithReport(manifest, rules, ctx).findings;
}

/** Count findings per severity, for the UI filter. */
export function summarizeFindings(findings) {
	const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
	const byCategory = {};
	for (const f of findings ?? []) {
		bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
		byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
	}
	return { bySeverity, byCategory, total: (findings ?? []).length };
}