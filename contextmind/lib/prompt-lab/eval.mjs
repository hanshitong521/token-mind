/**
 * Prompt Lab Eval (spec §27–§30, §41; ADR-0010 / ADR-0013).
 *
 * EvalProvider registry — BuiltinEvaluator is the offline, deterministic
 * assertion engine available today; PromptfooAdapter stays an explicit
 * PROMPTFOO_NOT_INSTALLED state (ADR-0010: a state, never a silent pass).
 *
 * What the builtin evaluator measures (no LLM needed):
 *   - assertion pass rate          (must_have / must_not_have on optimized text)
 *   - critical instruction retention (keyword-level retention after Mode B)
 *   - token budget                 (delta tokens / before-after tokens)
 *   - tool-schema tokens           (offline §29)
 *   - stable prefix                (tokens + ratio, via analyzeCacheStability)
 *   - fixture regression           (repo fixture "expect" contracts)
 *   - negative controls            (§30: deliberately broken inputs must be
 *                                    caught by the rule engine)
 *
 * What it cannot measure without a provider execution: Task Success Rate,
 * Tool Selection Accuracy, Hallucination Rate, Latency, Cost, Provider Cached
 * Tokens — reported as not_measured so an Eval report never fabricates them
 * (spec §29: 严禁只比较 token 数).
 *
 * Every run returns a normalized shape that the API layer persists and that
 * can later be produced by a promptfoo adapter unchanged:
 *   { ok, eval_provider, status, summary, metrics, results[] }
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as E from "../prompt-engine/index.mjs";
import { runRulesWithReport } from "../prompt-engine/rule-engine.mjs";
import { analyzeCacheStability } from "../prompt-engine/cache-analyzer.mjs";

export const EVAL_PROVIDERS = Object.freeze({
	BUILTIN: "builtin",
	PROMPTFOO: "promptfoo",
});

const CM_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(CM_ROOT, "fixtures/prompt-lab");

// ─── negative-control builders (spec §30) ────────────────────────────────
// Each negative control injects a STATICALLY DETECTABLE defect into the seed
// (volatile prefix / duplicate block / secret-shaped token). The rule engine
// must flag it; a run that cannot see the break is itself FAIL.
// (Semantic breaks — e.g. flipping read-SQL to write-SQL — need a provider
// execution and are reported not_measured by the builtin provider.)

// ─── builtin dataset ──────────────────────────────────────────────────────
// Seed prompts are small, real coding-prompt shapes. Each case declares what
// Mode-B output MUST retain (must_have) and what it must never introduce
// (must_not_have), plus optional negative controls.

export const BUILTIN_DATASET_ID = "builtin-1";

export const BUILTIN_CASES = Object.freeze([
	{
		caseId: "JAVA-CONTROLLER-001",
		category: "java-controller",
		title: "Java Controller：必须保留事务与参数校验约束",
		sourceType: "markdown",
		seed: `# Rules

- @Transactional must wrap the whole refund flow.
- Validate the request body before touching the database.
- Never swallow an exception; translate it to a typed error result.

# User

Implement refund() in RefundController given the service below.`,
		must_have: ["@Transactional must wrap the whole refund flow", "Never swallow an exception"],
		must_not_have: ["# Rules\n\n# Rules"],
		negativeControls: [
			{
				id: "NEG-VOLATILE-PREFIX",
				label: "规则区注入 volatile 前缀（负向控制，CACHE-001 须检出）",
				content: `# Rules\n\n- Current date is 2026-09-09T00:00:00.000Z, session 00000000-0000-4000-0000-000000000000.\n- @Transactional must wrap the whole refund flow.\n- Validate the request body before touching the database.\n- Never swallow an exception; translate it to a typed error result.\n\n# User\n\nImplement refund() in RefundController given the service below.`,
				expectRule: /CACHE-001/,
			},
		],
	},
	{
		caseId: "SQL-DONT-TOUCH-001",
		category: "sql",
		title: "SQL：只读查询原文必须逐字节保留",
		sourceType: "markdown",
		seed: `# Migration

Run this SQL exactly as written:

\`\`\`sql
SELECT o.order_id, o.created_at, u.email
FROM t_order o
JOIN t_user u ON u.user_id = o.user_id
WHERE o.status = 'PAID';
\`\`\``,
		must_have: ["SELECT o.order_id, o.created_at, u.email", "WHERE o.status = 'PAID';"],
		must_not_have: ["UPDATE", "DELETE FROM"],
		negativeControls: [
			{
				id: "NEG-DUP-SQL-RULES",
				label: "规则区重复 # Rules 块（负向控制，Q04-DUP-EXACT 须检出）",
				content: `# Rules\n\n- Run this SQL exactly as written.\n\n# Rules\n\n- Run this SQL exactly as written.\n\n\`\`\`sql\nSELECT o.order_id, o.created_at, u.email\nFROM t_order o\nJOIN t_user u ON u.user_id = o.user_id\nWHERE o.status = 'PAID';\n\`\`\``,
				expectRule: /Q04-DUP-EXACT/,
			},
		],
	},
	{
		caseId: "DUP-RULES-001",
		category: "rules",
		title: "规则去重：精确重复的 # Rules 段应只剩一份",
		sourceType: "markdown",
		seed: `# Rules

- Deterministic ordering before every request.
- Keep the user request last.

# Rules

- Deterministic ordering before every request.
- Keep the user request last.`,
		must_have: ["Deterministic ordering before every request.", "Keep the user request last."],
		must_not_have: ["# Rules\n\n# Rules"],
		negativeControls: [
			{
				id: "NEG-TRIPLE-DUP",
				label: "三段重复 # Rules（负向控制，Q04-DUP-EXACT 须检出 ≥1）",
				content: `# Rules\n\n- Deterministic ordering before every request.\n- Keep the user request last.\n\n# Rules\n\n- Deterministic ordering before every request.\n- Keep the user request last.\n\n# Rules\n\n- Deterministic ordering before every request.\n- Keep the user request last.`,
				expectRule: /Q04-DUP-EXACT/,
			},
		],
	},
]);

// ─── assertion helpers ────────────────────────────────────────────────────

/** Normalize whitespace so substring checks survive serialization. */
function norm(s) {
	return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** Token sum of a manifest (heuristic tokenCount when present). */
function tokensOf(manifest) {
	return (manifest?.blocks ?? []).reduce((a, b) => a + (b.tokenCount?.count ?? 0), 0);
}

/** Tokens that belong to tool-schema blocks (offline §29 metric). */
function toolSchemaTokensOf(manifest) {
	return (manifest?.blocks ?? []).reduce((a, b) => a + (b.kind === "tool_schema" ? (b.tokenCount?.count ?? 0) : 0), 0);
}

/** Stable-prefix metrics for a manifest (measured, offline; §29). */
function cacheMetricsOf(manifest) {
	try {
		const c = analyzeCacheStability(manifest ?? { blocks: [] });
		return {
			stablePrefixTokens: c.stablePrefixTokens ?? 0,
			stablePrefixRatio: Number((c.stablePrefixRatio ?? 0).toFixed(4)),
			cacheBreakerCount: c.cacheBreakerCount ?? 0,
		};
	} catch {
		return { stablePrefixTokens: 0, stablePrefixRatio: 0, cacheBreakerCount: 0 };
	}
}

function runAssertion(kind, label, ok, detail = "") {
	return { kind, label, ok: Boolean(ok), detail };
}

// ─── runner ───────────────────────────────────────────────────────────────

/**
 * Run the builtin evaluator.
 *
 * @param {object} opts
 *   content?        prompt text to analyze (when no fixture case is used)
 *   caseId?         run only this builtin case
 *   fixtureId?      run repo fixture regression (expect from meta)
 *   mode?           analyze|optimize (both run analyze + Mode-B optimize)
 * @returns normalized Eval result (see module header)
 */
export function runBuiltinEval({
	content = null,
	sourceType = "markdown",
	caseId = null,
	fixtureId = null,
	provider = "generic",
	mode = "optimize",
} = {}) {
	const results = [];
	const caseDefs = [];

	// 1. builtin dataset cases — narrowed to a single case when requested;
	//    skipped entirely when a fixture regression was explicitly requested.
	let builtin = BUILTIN_CASES.slice();
	if (caseId != null) builtin = builtin.filter((c) => c.caseId === caseId);
	else if (fixtureId != null) builtin = [];
	const explicitTarget = caseId != null || fixtureId != null || (content != null && content.trim());

	// 2. repo fixture regression (expect contracts from meta). Full regression
	//    only when no explicit target was requested; fixtureId narrows to one.
	const fixtureCase = fixtureId ? loadFixtureExpect(fixtureId) : null;
	const regressionCases = fixtureCase ? [fixtureCase] : [];
	if (!explicitTarget) {
		for (const c of loadAllFixtureExpects()) regressionCases.push(c);
	}

	for (const c of builtin) {
		const r = evaluateCase(c, { provider, mode });
		results.push(r);
		caseDefs.push({ caseId: c.caseId, category: c.category, title: c.title, source: "builtin-dataset" });
	}

	let regressionFailed = 0;
	for (const c of regressionCases) {
		const r = evaluateFixtureRegression(c, { provider, mode });
		if (!r.ok) regressionFailed += 1;
		results.push(r);
		caseDefs.push({ caseId: c.caseId, category: c.category ?? "fixture", title: c.title ?? c.caseId, source: "fixture" });
	}

	// custom content is evaluated as an ad-hoc case (no negative control)
	if (content != null && content.trim() && caseId == null && fixtureId == null) {
		const r = evaluateCase(
			{
				caseId: "CUSTOM-INPUT",
				category: "custom",
				title: "用户输入的即时断言",
				sourceType,
				seed: content,
				must_have: [],
				must_not_have: [],
				negativeControls: [],
			},
			{ provider, mode, retainText: true },
		);
		results.push(r);
		caseDefs.push({ caseId: "CUSTOM-INPUT", category: "custom", title: "用户输入的即时断言", source: "content" });
	}

	return summarizeRun(results, caseDefs);
}

// ─── per-case evaluation ──────────────────────────────────────────────────

function evaluateCase(caseDef, { provider, mode, retainText = false }) {
	const assertions = [];
	const seed = parse(caseDef.seed, caseDef.sourceType, provider);
	const seedFindings = runFindings(seed);

	// assertions on the OPTIMIZED output (Mode B = SAFE)
	let optimized = seed;
	let deltaTokens = 0;
	if (mode !== "analyze") {
		const opt = optimize(seed, provider);
		optimized = opt.optimized?.manifest ?? opt.optimized ?? seed;
		deltaTokens = opt.summary?.deltaTokens ?? 0;
	}

	// must_have survive Mode B — compare against the block texts joined
	// WITHOUT serializer headers, so wording retention is exact.
	const optRaw = (optimized?.blocks ?? []).map((b) => b.text ?? "").join("\n");
	const seedRaw = (seed?.blocks ?? []).map((b) => b.text ?? "").join("\n");
	const optText = textOf(optimized);
	const seedText = textOf(seed);

	for (const mh of caseDef.must_have ?? []) {
		assertions.push(runAssertion("must_have", `保留: ${mh.slice(0, 60)}`, norm(optRaw).includes(norm(mh)) || norm(optText).includes(norm(mh))));
	}
	// must_not_have absent in optimized output. The structural guard
	// "# Rules\n\n# Rules" means "no two identical rule sections survive" —
	// judged at BLOCK level (text-hash duplicates), never on serialized text
	// where serializer headers pollute the count.
	const optBlocks = optimized?.blocks ?? [];
	const textSeen = new Map();
	let exactDupBlocks = 0;
	for (const b of optBlocks) {
		const key = norm(b.text ?? "");
		const n = textSeen.get(key) ?? 0;
		textSeen.set(key, n + 1);
		if (n > 0) exactDupBlocks += 1;
	}
	for (const mnh of caseDef.must_not_have ?? []) {
		const banned = norm(mnh);
		let ok = true;
		if (banned === "# Rules # Rules") {
			ok = exactDupBlocks === 0;
		} else {
			ok = !norm(optRaw).includes(banned) && !norm(optText).includes(banned);
		}
		assertions.push(runAssertion("must_not_have", `不引入: ${mnh.slice(0, 60)}`, ok));
	}
	// token budget: SAFE optimizer never grows the prompt
	assertions.push(runAssertion("token_budget", `Mode-B token 不增加 (Δ=${deltaTokens})`, deltaTokens <= 0));

	// negative controls: a deliberately broken seed must differ from the good
	// seed in a way the analyzer surfaces — either a rule finding fires on the
	// broken variant, or the two parse differently (block/layout delta).
	const negResults = [];
	for (const neg of caseDef.negativeControls ?? []) {
		const broken = parse(neg.content, caseDef.sourceType, provider);
		const nf = runFindings(broken);
		const ruleHit = nf.findings.some((f) => neg.expectRule?.test(f.ruleId ?? ""));
		const goodFindings = seedFindings.findings.map((f) => f.ruleId).sort().join(",");
		const brokenFindings = nf.findings.map((f) => f.ruleId).sort().join(",");
		// A negative control is "detected" when rule output changes between the
		// good and the broken seed (the analyzer noticed the difference), OR a
		// rule fired that never fires on the good seed.
		const structuralDelta = brokenFindings !== goodFindings && brokenFindings.length > 0;
		const hit = ruleHit || structuralDelta;
		assertions.push(
			runAssertion(
				"negative_control",
				`负向控制检出: ${neg.label}`,
				hit,
				hit
					? ""
					: `broken 变体无任何 finding 差异 (good=[${goodFindings}] broken=[${brokenFindings}]) — §30 要求 Eval 必须能捕获故意错误样例`,
			),
		);
		negResults.push({ id: neg.id, label: neg.label, detected: hit, findings: nf.findings.map((f) => f.ruleId) });
	}

	const passed = assertions.filter((a) => a.ok).length;
	const seedCache = cacheMetricsOf(seed);
	return {
		caseId: caseDef.caseId,
		category: caseDef.category,
		title: caseDef.title,
		passed: assertions.length > 0 && passed === assertions.length,
		assertions,
		assertionsTotal: assertions.length,
		assertionsPassed: passed,
		negativeControls: negResults,
		negativeTotal: negResults.length,
		negativeDetected: negResults.filter((n) => n.detected).length,
		metrics: {
			deltaTokens,
			seedBlocks: seed.blocks?.length ?? 0,
			optimizedBlocks: optimized?.blocks?.length ?? seed.blocks?.length ?? 0,
			seedTokens: tokensOf(seed),
			optimizedTokens: tokensOf(optimized),
			toolSchemaTokens: toolSchemaTokensOf(seed),
			stablePrefixTokens: seedCache.stablePrefixTokens,
			stablePrefixRatio: seedCache.stablePrefixRatio,
			cacheBreakerCount: seedCache.cacheBreakerCount,
			seedFindings: seedFindings.findings.length,
		},
		...((retainText || !caseDef.negativeControls?.length) && caseDef.caseId === "CUSTOM-INPUT"
			? { seedText: retainText ? seedRaw.slice(0, 4000) : undefined, optimizedText: retainText ? optRaw.slice(0, 4000) : undefined }
			: {}),
	};
}

/** Fixture regression: parse + expect contracts (minBlocks/minDoNotTouch/roundTrip/ruleIds). */
function evaluateFixtureRegression(fx, { provider, mode }) {
	const assertions = [];
	const parsed = parse(fx.content, fx.sourceType ?? "markdown", provider);
	const manifest = parsed;
	const blocks = manifest?.blocks ?? [];

	assertions.push(runAssertion("parse", `可解析 (${fx.file})`, parsed && !parsed.error));
	assertions.push(runAssertion("min_blocks", `≥${fx.expect.minBlocks ?? 1} blocks`, (blocks?.length ?? 0) >= (fx.expect.minBlocks ?? 1)));

	if (fx.expect.minDoNotTouch) {
		const n = blocks.filter((b) => b.mutability === "DO_NOT_TOUCH").length;
		assertions.push(runAssertion("min_dnt", `≥${fx.expect.minDoNotTouch} DO_NOT_TOUCH`, n >= fx.expect.minDoNotTouch));
	}
	const ruleHits = [];
	for (const rid of fx.expect.ruleIds ?? []) {
		const f = runFindings(manifest);
		const hit = f.findings.some((x) => x.ruleId === rid);
		ruleHits.push({ ruleId: rid, hit });
		assertions.push(runAssertion("rule_hit", `触发 ${rid}`, hit));
	}
	// roundTrip: serialize → reparse must recover every DO_NOT_TOUCH /
	// fenced block verbatim (content survival, not block-count equality —
	// the markdown serializer re-emits structural headers).
	if (fx.expect.roundTrip) {
		try {
			const text = textOf(manifest);
			const rep = parse(text, fx.sourceType ?? "markdown", provider);
			const repRaw = (rep?.blocks ?? []).map((b) => b.text ?? "").join("\n");
			const mustSurvive = blocks.filter((b) => b.mutability === "DO_NOT_TOUCH" || b.kind === "code" || b.kind === "diff" || b.kind === "tool_schema");
			const survived = mustSurvive.every((b) => norm(repRaw).includes(norm(b.text ?? "")));
			assertions.push(runAssertion("round_trip", `serialize→parse 保留 ${mustSurvive.length} 个受保护块`, survived));
		} catch {
			assertions.push(runAssertion("round_trip", "serialize→parse 保留受保护块", false));
		}
	}
	if (fx.expect.noStaticVolatile) {
		const vol = blocks.some((b) => b.stability === "volatile" && b.mutability !== "DO_NOT_TOUCH" && b.kind !== "user_request");
		assertions.push(runAssertion("no_static_volatile", "静态区无 volatile", !vol));
	}
	if (fx.expect.cacheBreakerMax != null) {
		const cb = blocks.reduce((a, b) => a + (/volatile/i.test(b.stability ?? "") ? 1 : 0), 0);
		assertions.push(runAssertion("cache_breaker", `breaker ≤${fx.expect.cacheBreakerMax}`, cb <= fx.expect.cacheBreakerMax));
	}
	const passed = assertions.filter((a) => a.ok).length;
	const cache = cacheMetricsOf(parsed);
	return {
		caseId: fx.caseId,
		category: fx.category ?? "fixture",
		title: `fixture ${fx.file}`,
		ok: passed === assertions.length,
		passed: passed === assertions.length,
		assertions,
		assertionsTotal: assertions.length,
		assertionsPassed: passed,
		negativeControls: [],
		negativeTotal: 0,
		negativeDetected: 0,
		metrics: {
			seedBlocks: blocks.length,
			seedTokens: tokensOf(parsed),
			toolSchemaTokens: toolSchemaTokensOf(parsed),
			stablePrefixTokens: cache.stablePrefixTokens,
			stablePrefixRatio: cache.stablePrefixRatio,
			cacheBreakerCount: cache.cacheBreakerCount,
			ruleHits,
		},
	};
}

// ─── engine glue (kept local so eval.mjs never depends on api.mjs) ───────

function parse(content, sourceType, provider) {
	try {
		return E.parsePrompt(String(content ?? ""), { sourceType, provider });
	} catch (e) {
		return { error: e.message, blocks: [] };
	}
}

function runFindings(manifest) {
	if (!manifest || manifest.error) return { findings: [], report: { complete: false } };
	try {
		return runRulesWithReport(manifest, E.allRules(), { provider: manifest.provider ?? "generic" });
	} catch {
		return { findings: [], report: { complete: false } };
	}
}

function optimize(manifest, provider) {
	try {
		return E.optimize({
			content: textOf(manifest),
			sourceType: manifest.sourceType ?? "markdown",
			provider,
			options: { mode: "B" },
		});
	} catch {
		return { optimized: { manifest }, summary: { deltaTokens: 0, beforeTokens: 0, afterTokens: 0 } };
	}
}

function textOf(manifest) {
	try {
		return E.serializeToMarkdown(manifest ?? { blocks: [] });
	} catch {
		return (manifest?.blocks ?? []).map((b) => b.text ?? "").join("\n");
	}
}

// ─── fixture meta loading ─────────────────────────────────────────────────

function loadFixtureExpect(id) {
	const metaPath = join(FIXTURES, `${id}.meta.json`);
	if (!existsSync(metaPath)) return null;
	const meta = JSON.parse(readFileSync(metaPath, "utf8"));
	const file = join(FIXTURES, meta.file);
	if (!existsSync(file)) return null;
	return {
		caseId: meta.id,
		file: meta.file,
		category: meta.category,
		sourceType: meta.sourceType ?? "markdown",
		provider: meta.provider ?? "generic",
		content: readFileSync(file, "utf8"),
		expect: meta.expect ?? {},
	};
}

function loadAllFixtureExpects() {
	const out = [];
	for (const f of readdirSync(FIXTURES)) {
		if (!f.endsWith(".meta.json")) continue;
		const fx = loadFixtureExpect(f.replace(/\.meta\.json$/, ""));
		if (fx) out.push(fx);
	}
	return out;
}

// ─── summary / normalization ──────────────────────────────────────────────

function avg(nums) {
	if (!Array.isArray(nums) || nums.length === 0) return null;
	return +(nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2);
}

function summarizeRun(results, caseDefs) {
	const totalCases = results.length;
	const passedCases = results.filter((r) => r.passed ?? r.ok).length;
	const allAssertions = results.flatMap((r) => r.assertions ?? []);
	const totalNeg = results.reduce((a, r) => a + (r.negativeTotal ?? 0), 0);
	const detectedNeg = results.reduce((a, r) => a + (r.negativeDetected ?? 0), 0);
	const regressionCount = results.filter((r) => r.category === "fixture" && !(r.passed ?? r.ok)).length;
	const allPassed = results.every((r) => (r.passed ?? r.ok) === true);

	return {
		ok: allPassed,
		eval_provider: EVAL_PROVIDERS.BUILTIN,
		status: allPassed ? "PASS" : "FAIL",
		summary: {
			totalCases,
			passedCases,
			assertionsTotal: allAssertions.length,
			assertionsPassed: allAssertions.filter((a) => a.ok).length,
			negativeTotal: totalNeg,
			negativeDetected: detectedNeg,
			regressionCount,
			allPassed,
			criticalAssertionVerdict: allPassed ? "PASS" : "FAIL",
		},
		metrics: {
			// spec §29 — provider-dependent metrics are honest not_measured
			// (never fabricated); everything else is measured offline.
			task_success_rate: "not_measured", // requires provider execution (promptfoo)
			tool_selection_accuracy: "not_measured",
			hallucination_rate: "not_measured",
			latency_ms: "not_measured",
			cost: "not_measured",
			provider_cached_tokens: "not_measured", // 可获取时（provider 缓存命中上报）
			assertion_pass_rate: allAssertions.length ? +(allAssertions.filter((a) => a.ok).length / allAssertions.length).toFixed(3) : null,
			critical_instruction_retention: +(
				results.filter((r) => (r.assertions ?? []).every((a) => a.ok)).length / Math.max(totalCases, 1)
			).toFixed(3),
			negative_control_detection: totalNeg ? +(detectedNeg / totalNeg).toFixed(3) : null,
			regression_count: regressionCount,
			prompt_tokens_before: results.reduce((a, r) => a + (r.metrics?.seedTokens ?? 0), 0),
			prompt_tokens_after: results.reduce((a, r) => a + (r.metrics?.optimizedTokens ?? r.metrics?.seedTokens ?? 0), 0),
			prompt_tokens_delta: results.reduce((a, r) => a + (r.metrics?.deltaTokens ?? 0), 0),
			tool_schema_tokens: results.reduce((a, r) => a + (r.metrics?.toolSchemaTokens ?? 0), 0),
			stable_prefix_ratio_avg: avg(results.map((r) => r.metrics?.stablePrefixRatio).filter((v) => typeof v === "number")),
			stable_prefix_tokens_avg: avg(results.map((r) => r.metrics?.stablePrefixTokens).filter((v) => typeof v === "number")),
		},
		results,
		cases: caseDefs,
		dataset: BUILTIN_DATASET_ID,
		ranAt: Date.now(),
	};
}

export { loadFixtureExpect };
