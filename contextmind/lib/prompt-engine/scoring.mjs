/**
 * Scoring — five independent scores, never a blended headline.
 *
 * Prompt Lab spec §17: a single aggregate hides risk. We always report:
 *   quality ✓ clarity/consistency/actionability/verifiability/tool_contract/structure
 *   cacheStability (see cache-analyzer.cacheStabilityScore)
 *   tokenEfficiency (see token-analyzer.tokenEfficiencyScore)
 *   determinism — same input ⇒ same output (always 100 for a deterministic engine unless evidence)
 *   risk — higher is worse (derived from CRITICAL/HIGH findings + rewrite flags)
 *
 * Plus §17.6 publish gate: quality_after >= quality_before - tolerance etc.
 */

import { cacheStabilityScore } from "./cache-analyzer.mjs";
import { tokenEfficiencyScore } from "./token-analyzer.mjs";

const SEVERITY_WEIGHT = { INFO: 1, LOW: 2, MEDIUM: 4, HIGH: 8, CRITICAL: 24 };

/**
 * Quality dimensions (spec §17.1):
 *  clarity / consistency / actionability / verifiability / tool_contract / structure
 * Each computed heuristically from the manifest + findings.
 */
export function qualityScore(manifest, findings = [], cacheMetrics = null) {
	const text = (manifest?.blocks ?? []).map((b) => b.text).join("\n");
	const userBlocks = (manifest?.blocks ?? []).filter((b) => b.role === "user" || b.kind === "user_request");
	const job = userBlocks.map((b) => b.text).join("\n");

	// clarity: explicit action verbs present
	const clarity = hasActionVerbs(job) ? 90 : 40;
	// consistency: no HIGH conflict findings
	const conflicts = findings.filter((f) => f.ruleId === "Q03-CONFLICT").length;
	const consistency = Math.max(0, 100 - conflicts * 50);
	// actionability: explicit verbs + not only background
	const actionability = hasActionVerbs(text) ? 88 : 45;
	// verifiability: acceptance markers present
	const verifiability = hasAcceptance(job) ? 92 : 55;
	// tool_contract: tool usage explained when tools exist in job
	const toolContract = hasToolContract(job) ? 85 : 60;
	// structure: manifest is block-structured, not a flat blob
	const structure = (manifest?.blocks?.length ?? 0) >= 2 ? 90 : 50;

	const score = Math.round((clarity + consistency + actionability + verifiability + toolContract + structure) / 6);

	return {
		score: Math.max(0, Math.min(100, score)),
		dimensions: {
			clarity,
			consistency,
			actionability,
			verifiability,
			tool_contract: toolContract,
			structure,
		},
		conflicts,
	};
}

function hasActionVerbs(text) {
	return /(?:implement|fix|refactor|rename|write|create|add|remove|change|update|delete|verify|test|bug|修复|重构|实现|编写|创建|新增|修改|更新|验证|测试|调试|优化|生成|迁移|压缩)/i.test(text);
}
function hasAcceptance(text) {
	return /(?:acceptance|done when|definition of done|pass|verify|测试|验收标准|通过|验证|build)/i.test(text);
}
function hasToolContract(text) {
	return /(?:tool|shell|mcp|命令|工具|调用|run|执行)/i.test(text);
}

/** Determinism — engine is deterministic; only interrupted by unknown inputs. */
export function determinismScore(manifest, findings = []) {
	// dynamic blocks lower determinism slightly (the manifest is still stable,
	// but the underlying prompt is not).
	const dynamicBlocks = (manifest?.blocks ?? []).filter((b) => b.stability === "DYNAMIC" || b.stability === "EPHEMERAL").length;
	const score = Math.max(40, 100 - dynamicBlocks * 5);
	return { score, dynamicBlocks };
}

/**
 * Risk Score — higher is more dangerous (spec §17.5). Driven by
 * CRITICAL/HIGH findings (secrets, conflicts, cache breakers) and any
 * sematic/lossy rewrite intent in the patch.
 */
export function riskScore(manifest, findings = [], patch = null) {
	let weight = 0;
	for (const f of findings ?? []) weight += SEVERITY_WEIGHT[f.severity] ?? 1;
	if (patch?.risk === "EXPERIMENTAL") weight += 30;
	if (patch?.risk === "REVIEW") weight += 12;
	// secrets are the worst
	if (findings?.some((f) => f.ruleId === "SAFE-002")) weight += 50;
	const score = Math.min(100, Math.round((weight / 60) * 50)); // normalize
	return { score, weight, note: score > 60 ? "high" : score > 30 ? "medium" : "low" };
}

/**
 * Full scorecard. Returns object with the five scores plus a `gate` that
 * tells whether an optimization is ready for promotion (spec §17.6).
 *
 * `ruleExecution` is the report from rule-engine.runRulesWithReport; passing
 * it is what makes "no recommend while rules are broken" enforceable.
 */
export function scoreManifest(
	manifest,
	findings = [],
	{ baseline = null, patch = null, ruleExecution = null, assertions = null, tokensAfter = null } = {},
) {
	const cache = cacheStabilityScore(manifest);
	const quality = qualityScore(manifest, findings, cache);
	const tokens = (manifest?.blocks ?? []).reduce((a, b) => a + (b.tokenCount?.count ?? 0), 0);
	const tokenEfficiency = { score: tokenEfficiencyScore({ PromptTotal: tokens, total_duplicate_tokens: duplicateTokensFrom(findings) }) };
	const determinism = determinismScore(manifest, findings);
	const risk = riskScore(manifest, findings, patch);

	const gate = evaluateGate({
		quality,
		cache,
		tokenEfficiency,
		risk,
		baseline,
		tokens,
		tokensAfter: tokensAfter ?? (baseline ? tokens : null),
		patch,
		ruleExecution,
		assertions,
	});

	return {
		scores: {
			quality: quality.score,
			cacheStability: cache.score,
			tokenEfficiency: tokenEfficiency.score,
			determinism: determinism.score,
			risk: risk.score,
		},
		dimensions: { quality: quality.dimensions, cache: cache.dimensions },
		riskDetails: { weight: risk.weight, note: risk.note },
		gate,
	};
}

function duplicateTokensFrom(findings) {
	return (
		findings?.filter((f) => f.ruleId === "Q04-DUP-EXACT" || f.ruleId === "Q12-SCHEMA-DUP" || f.ruleId === "CACHE-004")
			.reduce((a, f) => a + Math.abs(f.estimatedTokenDelta || 0), 0) ?? 0
	);
}

/**
 * Three-valued verdict. There is no path from "we did not measure this" to
 * "this passed" — that is the exact failure mode this gate exists to prevent
 * (a hardcoded `token_not_increased = true` used to make every result green).
 */
export const VERDICT = Object.freeze({ PASS: "PASS", FAIL: "FAIL", UNKNOWN: "UNKNOWN" });

/** Checks whose UNKNOWN blocks promotion. Everything else must merely not FAIL. */
export const CRITICAL_CHECKS = Object.freeze([
	"rule_execution_complete",
	"critical_assertions_pass",
	"safety_regression_zero",
]);

export const QUALITY_TOLERANCE = 5;
export const RISK_TOLERANCE = 60;

/**
 * Publish gate (spec §17.6), three-state.
 *
 *  rule_execution_complete    every registered rule ran and none threw
 *  critical_assertions_pass   supplied by Eval; UNKNOWN when no Eval was run
 *  safety_regression_zero     risk score within tolerance
 *  quality_after_ge_before    non-critical; UNKNOWN without a baseline
 *  cache_stability_not_decreased  non-critical; UNKNOWN without a baseline
 *  token_not_increased        non-critical; UNKNOWN when either side unmeasured
 *
 * recommendable ⇔ all critical checks PASS and no check FAILs.
 */
export function evaluateGate({
	quality,
	cache,
	risk,
	baseline = null,
	tokens = 0,
	tokensAfter = null,
	patch = null,
	ruleExecution = null,
	assertions = null,
} = {}) {
	const { PASS, FAIL, UNKNOWN } = VERDICT;
	const checks = {};

	// — critical ——————————————————————————————————————————————
	if (!ruleExecution || typeof ruleExecution.total !== "number") {
		checks.rule_execution_complete = UNKNOWN;
	} else if (ruleExecution.total === 0) {
		checks.rule_execution_complete = UNKNOWN;
	} else {
		checks.rule_execution_complete = ruleExecution.complete ? PASS : FAIL;
	}

	if (assertions && typeof assertions.pass === "boolean") {
		checks.critical_assertions_pass = assertions.pass ? PASS : FAIL;
	} else {
		// No Eval ⇒ we do not know. Never default to PASS.
		checks.critical_assertions_pass = UNKNOWN;
	}

	if (checks.rule_execution_complete === FAIL || checks.rule_execution_complete === UNKNOWN) {
		// A risk score computed from missing/broken findings is not a measurement.
		checks.safety_regression_zero = UNKNOWN;
	} else {
		checks.safety_regression_zero = (risk?.score ?? 100) <= RISK_TOLERANCE ? PASS : FAIL;
	}

	// — non-critical ——————————————————————————————————————————
	if (baseline?.scores) {
		checks.quality_after_ge_before =
			(quality?.score ?? 0) >= baseline.scores.quality - QUALITY_TOLERANCE ? PASS : FAIL;
		checks.cache_stability_not_decreased =
			(cache?.score ?? 0) >= baseline.scores.cacheStability ? PASS : FAIL;
	} else {
		checks.quality_after_ge_before = UNKNOWN;
		checks.cache_stability_not_decreased = UNKNOWN;
	}

	const beforeTokens = baseline?.tokens ?? null;
	if (tokensAfter == null || beforeTokens == null) {
		checks.token_not_increased = UNKNOWN;
	} else {
		checks.token_not_increased = tokensAfter <= beforeTokens ? PASS : FAIL;
	}

	const reasons = [];
	for (const [name, verdict] of Object.entries(checks)) {
		if (verdict === FAIL) reasons.push(`${name}=FAIL`);
		else if (verdict === UNKNOWN) reasons.push(`${name}=UNKNOWN`);
	}

	const blockingCritical = CRITICAL_CHECKS.filter((c) => checks[c] !== PASS);
	const recommendable =
		blockingCritical.length === 0 && !Object.values(checks).includes(FAIL);

	return {
		recommendable,
		checks,
		verdicts: checks,
		criticalChecks: CRITICAL_CHECKS.slice(),
		blocking: [...blockingCritical, ...Object.entries(checks).filter(([, v]) => v === FAIL).map(([k]) => k)],
		reasons,
		note: recommendable
			? "all critical checks PASS, no check FAIL"
			: `not recommendable: ${blockingCritical.length ? `critical not PASS [${blockingCritical.join(", ")}]` : ""}${
					blockingCritical.length && reasons.length ? "; " : ""
			  }${reasons.filter((r) => !blockingCritical.some((c) => r.startsWith(c))).join(", ")}`,
	};
}

/** True when a gate verdict set permits promotion. Kept as a pure helper for tests. */
export function gateAllowsPromotion(gate) {
	if (!gate) return false;
	const checks = gate.checks ?? {};
	return (
		CRITICAL_CHECKS.every((c) => checks[c] === VERDICT.PASS) &&
		!Object.values(checks).includes(VERDICT.FAIL)
	);
}