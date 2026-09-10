/**
 * Prompt Engine — single public entry for Prompt Lab (spec §P12: one engine,
 * multiple surfaces). Runtime hooks, the lab UI, and future gateway all call
 * this same module so rules never drift.
 *
 * Exposed pipelines:
 *  analyze(config)   → full static report (manifest + scores + findings +
 *                       tokens + cache + fingerprint + rule execution report)
 *  optimize(config)  → SAFE-mode reversible patch
 *  diffSnapshots(a,b)
 *  exporter          → serializeToMarkdown/Messages/Anthropic
 *
 * Baseline integrity rules (round-1 decision, non-negotiable):
 *  1. Every registered rule must actually execute. A broken rule is a CRITICAL
 *     DETERMINISM finding, never an INFO placeholder, and it blocks the gate.
 *  2. Secret material never leaves `analyze()` in the clear. Redaction is ON
 *     by default; showing raw input is an explicit opt-out.
 *  3. No gate check may be a hardcoded `true`. Unmeasured means UNKNOWN, and
 *     an UNKNOWN critical check blocks "recommend apply".
 */

import { parsePrompt, serializeToMarkdown, serializeToMessages, serializeToAnthropic } from "./parser.mjs";
import { createManifest, cloneManifest, manifestTokenTotal, manifestToText } from "./manifest.mjs";
import { computeFingerprint, diffSnapshots, segmentMap } from "./fingerprint.mjs";
import { analyzeCacheStability, cacheStabilityScore, compareCacheRegression } from "./cache-analyzer.mjs";
import { analyzeTokens, tokenEfficiencyScore } from "./token-analyzer.mjs";
import { qualityScore, determinismScore, riskScore, scoreManifest } from "./scoring.mjs";
import { runRulesWithReport, createFinding } from "./rule-engine.mjs";
import { duplicateRules, tokenDupRules } from "./duplicate-detector.mjs";
import { conflictRule } from "./conflict-detector.mjs";
import { safetyRules } from "./safety-rules.mjs";
import { qualityRules } from "./quality-analyzer.mjs";
import { earlyVolatilityRule, orderingDriftRule, dynamicInStaticRule, schemaDupCacheRule } from "./cache-rules.mjs";
import { optimizeManifest, finalizeOptimization, normalizeMode, OPTIMIZE_MODE, RECOMMENDATION, optimizeSafe } from "./optimizer.mjs";
import { createPatch, applyPatch, patchOpsBetween, reverseOps } from "./patch.mjs";
import { getProviderCapabilities, listProviders } from "./providers.mjs";
import { redactManifestBlocks, redactDeep, scanSecrets } from "./secrets.mjs";
import { TOKENIZER_ID } from "../tokens.mjs";

export const ENGINE_VERSION = "1.0.0";
export const RULE_PACK_VERSION = "1.0.0";

/** All rules assembled; extend here when adding packs. */
export function allRules() {
	return [
		...duplicateRules,
		...tokenDupRules,
		conflictRule,
		...safetyRules,
		{ id: "CACHE-001", title: "Early volatility", category: "CACHE", severity: "HIGH", run: earlyVolatilityRule },
		{ id: "CACHE-002", title: "Ordering drift", category: "CACHE", severity: "MEDIUM", run: orderingDriftRule },
		{ id: "CACHE-003", title: "Dynamic in static", category: "CACHE", severity: "MEDIUM", run: dynamicInStaticRule },
		{ id: "CACHE-004", title: "Schema duplicate cost", category: "CACHE", severity: "MEDIUM", run: schemaDupCacheRule },
		{ id: "QUALITY-PACK", title: "Q01–Q15", category: "QUALITY", severity: "LOW", run: (m, c) => qualityRules(m, c) },
	];
}

/**
 * SAFE-002 is computed BEFORE redaction (after redaction the evidence is gone)
 * and carries only category labels — never the credential itself.
 */
function secretFindingsFor(manifest) {
	const findings = [];
	for (const block of manifest?.blocks ?? []) {
		const scan = scanSecrets(block.text);
		if (scan.count === 0) continue;
		findings.push(
			createFinding({
				ruleId: "SAFE-002",
				title: "Secret-like material detected",
				severity: "CRITICAL",
				category: "RISK",
				blockIds: [block.id],
				explanation:
					`Block carries ${Object.keys(scan.byName).join(", ")} (${scan.count} hit(s)). ` +
					`The returned manifest is redacted; nothing was persisted or forwarded in the clear (spec §38).`,
				evidence: Object.entries(scan.byName).map(([label, n]) => ({ label, count: n })),
				requiresEval: false,
				autoApplicable: false,
			}),
		);
	}
	return findings;
}

/**
 * Full static analysis (spec §35 analyze contract).
 * config: { content, sourceType, provider, model, options:{quality,cache,token,redactSecrets} }
 *
 * `options.redactSecrets` defaults to TRUE. Set it to false only for a local
 * live-input view that never leaves the process.
 */
export function analyze(config = {}) {
	const {
		content,
		sourceType,
		provider = null,
		model = null,
		projectId = null,
		options = {},
	} = config;

	const redact = options.redactSecrets !== false;
	const parsed = parsePrompt(content, { sourceType, provider, model, projectId });

	// 1. secrets: detect on the raw parse, report by label only
	const secretFindings = secretFindingsFor(parsed);
	const secretScan = scanSecrets(manifestToText(parsed));

	// 2. everything downstream runs on the safe projection
	const work = redact ? redactManifestBlocks(parsed).manifest : parsed;

	// 3. rules — with an execution report the gate can depend on
	const { findings: ruleFindings, report: ruleExecution } = runRulesWithReport(work, allRules(), { provider, model });
	const findings = redact ? redactDeep([...ruleFindings, ...secretFindings]) : [...ruleFindings, ...secretFindings];

	// 4. analyzers (gated by options)
	const tokens = options.token === false ? null : analyzeTokens(work);
	const cacheMetrics = options.cache === false ? null : analyzeCacheStability(work);

	// 5. fingerprint
	const fingerprint = computeFingerprint(work, {
		stablePrefixTokens: cacheMetrics?.stablePrefixTokens ?? null,
		firstDynamicBlock: cacheMetrics?.firstDynamicBlock ?? null,
	});

	// 6. scores + gate. Assertions are not available in a static pass, so
	//    critical_assertions_pass is UNKNOWN — which blocks recommendability.
	const scored = scoreManifest(work, findings, {
		patch: null,
		baseline: null,
		ruleExecution,
		assertions: options.assertions ?? null,
	});

	return {
		engineVersion: ENGINE_VERSION,
		rulePackVersion: RULE_PACK_VERSION,
		tokenizer: TOKENIZER_ID,
		redacted: redact,
		manifest: work,
		scores: scored.scores,
		scoreDimensions: scored.dimensions,
		riskDetails: scored.riskDetails,
		tokens,
		cache: cacheMetrics,
		findings,
		findingsSummary: summarize(findings),
		fingerprint,
		providerCapabilities: getProviderCapabilities(provider),
		secrets: { count: secretScan.count, byName: secretScan.byName, redacted: redact },
		ruleExecution,
		gate: scored.gate,
	};
}

function summarize(findings) {
	const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
	for (const f of findings ?? []) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
	return bySeverity;
}

/**
 * Optimize entry (spec §14, §35). Four modes — A ANALYZE_ONLY (default of the
 * lab), B SAFE, C CONSERVATIVE_REWRITE, D EXPERIMENTAL — see optimizer.mjs /
 * ADR-0011.
 *
 * config: { content, sourceType, provider, model,
 *           options: { mode, redactSecrets, assertions, allowExperimental,
 *                      compressorAdapter } }
 *
 * Both sides run the FULL rule pack with execution reports, and the after
 * side is scored against the before side as baseline, so the gate can never
 * clear on a one-sided measurement (round-1 gate #11/#13).
 *
 * Output carries the P6 bundle (original / normalized / optimized / patch /
 * fingerprint) plus `verification` (the optimizer's mechanical proof) and
 * `recommendation` (risk-aware apply advice — separate from the publish gate,
 * which additionally demands Eval evidence).
 */
export function optimize(config = {}) {
	const { content, sourceType, provider = null, model = null, options = {} } = config;
	const redact = options.redactSecrets !== false;
	const mode = normalizeMode(options.mode);

	const originalManifest = parsePrompt(content, { sourceType, provider, model });
	const beforeRun = runRulesWithReport(originalManifest, allRules(), { provider, model });

	const raw = optimizeManifest(originalManifest, {
		mode,
		allowExperimental: options.allowExperimental === true,
		compressorAdapter: options.compressorAdapter === true,
	});
	const optimizedManifest = raw.optimized.manifest;
	const afterRun = runRulesWithReport(optimizedManifest, allRules(), { provider, model });

	const beforeScores = scoreManifest(originalManifest, beforeRun.findings, { ruleExecution: beforeRun.report });
	const afterScores = scoreManifest(optimizedManifest, afterRun.findings, {
		baseline: { scores: beforeScores.scores, tokens: raw.summary.beforeTokens },
		patch: raw.patch,
		ruleExecution: afterRun.report,
		assertions: options.assertions ?? null,
		tokensAfter: raw.summary.afterTokens,
	});

	const finalized = finalizeOptimization(raw, {
		runBefore: beforeRun.report,
		runAfter: afterRun.report,
		gate: afterScores.gate,
	});

	const project = (m) => (redact ? redactManifestBlocks(m).manifest : m);
	const findingsOf = (fs) => (redact ? redactDeep(fs) : fs);

	return {
		engineVersion: ENGINE_VERSION,
		tokenizer: TOKENIZER_ID,
		redacted: redact,
		mode,
		original: {
			manifest: project(finalized.original.manifest),
			fingerprint: finalized.original.fingerprint,
			scores: beforeScores.scores,
			tokens: finalized.original.tokens,
			ruleExecution: beforeRun.report,
		},
		normalized: {
			manifest: project(finalized.normalized.manifest),
			fingerprint: finalized.normalized.fingerprint,
			tokens: finalized.normalized.tokens,
		},
		optimized: {
			manifest: project(finalized.optimized.manifest),
			fingerprint: finalized.optimized.fingerprint,
			scores: afterScores.scores,
			tokens: finalized.optimized.tokens,
			ruleExecution: afterRun.report,
		},
		findings: findingsOf([...afterRun.findings, ...raw.suggestions.map(suggestToFinding)]),
		patch: finalized.patch,
		patchOps: finalized.patchOps,
		reverse: finalized.reverse,
		suggestions: raw.suggestions,
		pendingEval: raw.pendingEval,
		verification: finalized.verification,
		recommendation: finalized.recommendation,
		summary: {
			...finalized.summary,
			lossless_saved: finalized.summary.lossless_saved,
		},
		gate: afterScores.gate,
	};
}

/** Render a schema-dup suggestion as a §25-shaped finding for UI/reporting. */
function suggestToFinding(s) {
	return {
		id: "suggestion",
		ruleId: s.ruleId,
		severity: s.severity,
		category: s.category,
		blockIds: s.blockRefs?.map((r) => r.blockId) ?? [],
		title: s.title,
		explanation: `${s.why}. ${s.reason}`,
		evidence: [],
		proposal: s.proposal,
		estimatedTokenDelta: s.tokenDelta,
		requiresEval: false,
		autoApplicable: false,
	};
}

/** Diff two contents or manifests (spec §24, §35 diff contract). */
export function diff(a, b, { provider = null } = {}) {
	const ma = typeof a === "string" ? parsePrompt(a, { provider }) : a;
	const mb = typeof b === "string" ? parsePrompt(b, { provider }) : b;
	return {
		diff: diffSnapshots(ma, mb),
		cacheRegression: compareCacheRegression(ma, mb),
		segmentsBefore: segmentMap(ma),
		segmentsAfter: segmentMap(mb),
	};
}

/** Fingerprint summary for a content/manifest (spec §23). */
export function fingerprint(content, { provider = null, model = null } = {}) {
	const manifest = typeof content === "string" ? parsePrompt(content, { provider, model }) : content;
	const cache = analyzeCacheStability(manifest);
	return computeFingerprint(manifest, {
		stablePrefixTokens: cache.stablePrefixTokens,
		firstDynamicBlock: cache.firstDynamicBlock,
	});
}

export { summarize as summarizeFindings };

export {
	parsePrompt,
	createManifest,
	cloneManifest,
	serializeToMarkdown,
	serializeToMessages,
	serializeToAnthropic,
	createPatch,
	applyPatch,
	patchOpsBetween,
	reverseOps,
	getProviderCapabilities,
	listProviders,
	redactManifestBlocks,
	manifestTokenTotal,
	scoreManifest,
	qualityScore,
	determinismScore,
	riskScore,
	cacheStabilityScore,
	tokenEfficiencyScore,
	analyzeCacheStability,
	optimizeSafe,
	optimizeManifest,
	finalizeOptimization,
	normalizeMode,
	OPTIMIZE_MODE,
	RECOMMENDATION,
};
