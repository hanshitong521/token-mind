/**
 * Quality Rules Q01–Q15 — deterministic, heuristic checks for prompt quality.
 *
 * Prompt Lab spec §12 lists the mandatory rule pack. Each rule is a pure
 * function (manifest, ctx) => PromptFinding[]. Heuristics are intentionally
 * conservative: never claim a defect without a token matched, and every
 * suggestion is marked requiring eval when it would rewrite content.
 */

import { createFinding } from "./rule-engine.mjs";
import { declaredStability } from "./segment-classifier.mjs";

const VAGUE_VERBS = [
	/\b(?:please\s+|kindly\s+)?(?:look\s*(?:at|over|into)|consider|research|investigate|explore|review\s*$|check\s*out|figure\s*(?:out|it)|think\s+about)\b/i,
	/(看看|考虑(?:一下)?|研究一下|调查一下|了解一下|探索|琢磨|想想)/,
];

const ACTION_VERBS = [
	/\b(?:implement|fix|refactor|rename|write|create|add|remove|change|update|delete|verify|test|benchmark|debug|optimize|compress|document|explain|compare|migrate|generate)\b/i,
	/(实现|修复|重构|重命名|编写|创建|新增|删除|修改|更新|验证|测试|压测|调查|调试|优化|压缩|文档|解释|比较|迁移|生成)/,
];

const ACCEPTANCE_MARKERS = [
	/(?:acceptance|done when|definition of done|verify(?: that)?|assert(?: that)?|pass(?:es)?\s+criteria|expected\s+output|验收标准|验收|完成标准|验证点|通过标准|预期输出)/i,
];

const OUTPUT_STRUCTURE_MARKERS = [
	/\b(?:output|return|result|format|json|schema|table|list|report|exit\s+code|stdout|stderr)\b/i,
	/(输出|返回|结果|格式|结构|表格|清单|报告)/,
];

const TOOL_CONTRACT_MARKERS = [
	/(?:use\s+(?:the\s+)?tool|call\s+(?:the\s+)?tool|tool\s+usage|mcp|when\s+.*should\s|side\s*effect|副作用|调用工具|工具使用|何时调用)/i,
];

const PERSONA_OVERLOAD_PATTERNS = [
	/(?:world[- ]?class|expert|senior|10x|master|guru|顶尖|世界顶级|资深|大师|专家|金牌|全栈)/gi,
];

const NEGATIVE_OVERLOAD = [
	/(?:do\s+not|don'?t|never|cannot|must\s+not|禁止|不要|不能|绝对不要|千万别|严禁)/gi,
];

const CONDITIONAL_QUALIFIERS = /(?:if\s+.*then|when\s+.*should|unless|until|也许|可能|如果|当|除非|可能需要)/i;

const HALLMARK_BOILERPLATE = [
	/\bas an? (?:ai|language model|assistant)\b/i,
	/你是[^，。\n]{0,20}(助手|智能体|模型)/,
	/\bhere[’']s what (?:i|you) can do\b/i,
];

function severityOfHtml() {
	return "LOW";
}
/** Q01: background exists but no requested action. */
export function q01NoGoal(manifest, ctx = {}) {
	const text = (manifest?.blocks ?? []).map((b) => b.text).join("\n");
	const hasAction = ACTION_VERBS.some((re) => re.test(text));
	if (hasAction) return [];
	const hasBackground = text.trim().length > 80;
	return [
		createFinding({
			ruleId: "Q01",
			title: "Goal unclear — no explicit action",
			severity: "HIGH",
			category: "QUALITY",
			blockIds: (manifest?.blocks ?? []).map((b) => b.id),
			explanation:
				hasBackground
					? "The prompt provides context but says nothing about what to do. State the action the agent must take."
					: "No action verb found. Ask what the model should actually do.",
			evidence: [{ text: text.slice(0, 240) }],
			requiresEval: false,
			autoApplicable: false,
		}),
	];
}

/** Q02: vague verbs without clear expected change. */
export function q02VagueVerbs(manifest, ctx = {}) {
	const findings = [];
	for (const block of manifest?.blocks ?? []) {
		for (const re of VAGUE_VERBS) {
			const m = block.text.match(re);
			if (!m) continue;
			findings.push(
				createFinding({
					ruleId: "Q02",
					title: `Vague action verb: "${m[0].trim()}"`,
					severity: "MEDIUM",
					category: "QUALITY",
					blockIds: [block.id],
					explanation:
						"A vague verb (look/consider/research) implies inspection, not change. " +
						"Prefer explicit: locate → modify → verify → output evidence.",
					evidence: [{ text: m[0] }],
					requiresEval: false,
					autoApplicable: false,
				}),
			);
			break;
		}
	}
	return findings.slice(0, 12);
}

/** Q03: conflicting constraints. Delegates to conflict-detector (assembled elsewhere). */

/** Q04 handled in duplicate-detector (exact/near). */

/** Q05: persona overload — many identity claims, few constraints. */
export function q05PersonaOverload(manifest, ctx = {}) {
	const text = (manifest?.blocks ?? []).map((b) => b.text).join("\n");
	let hits = 0;
	const evidence = [];
	for (const re of PERSONA_OVERLOAD_PATTERNS) {
		const ms = [...text.matchAll(re)];
		hits += ms.length;
		for (const m of ms.slice(0, 6)) evidence.push({ text: m[0] });
	}
	if (hits < 3) return [];
	return [
		createFinding({
			ruleId: "Q05",
			title: `Persona overload (${hits} identity claims)`,
			severity: "LOW",
			category: "QUALITY",
			blockIds: [],
			explanation:
				"Repeated 'world-class / top expert' claims produce no executable constraint. " +
				"Replace identity padding with concrete rules.",
			evidence,
			requiresEval: false,
			autoApplicable: false,
		}),
	];
}

/** Q06: no priority ordering (no P0/P1 statement). */
export function q06PriorityMissing(manifest, ctx = {}) {
	const text = (manifest?.blocks ?? []).map((b) => b.text).join("\n");
	if (/(?:priority|priorities|优先级|最重要|最高优先|p0|critical path)/i.test(text)) return [];
	return [
		createFinding({
			ruleId: "Q06",
			title: "No explicit priority ordering",
			severity: "LOW",
			category: "QUALITY",
			blockIds: (manifest?.blocks ?? []).map((b) => b.id),
			explanation:
				"The prompt never states which constraints dominate (e.g. safety > correctness > latency).",
			requiresEval: false,
			autoApplicable: false,
		}),
	];
}

/** Q07: task implies structured output but no output contract. */
export function q07OutputContract(manifest, ctx = {}) {
	const userBlocks = (manifest?.blocks ?? []).filter((b) => b.role === "user" || b.kind === "user_request");
	if (userBlocks.length === 0) return [];
	const job = userBlocks.map((b) => b.text).join("\n");
	const wantsOutput = OUTPUT_STRUCTURE_MARKERS.some((re) => re.test(job));
	const hasContract = ACCEPTANCE_MARKERS.some((re) => re.test(job)) || /(?:output|result)\s*[:=(]/.test(job);
	if (wantsOutput && !hasContract) {
		return [
			createFinding({
				ruleId: "Q07",
				title: "Output contract missing",
				severity: "MEDIUM",
				category: "QUALITY",
				blockIds: userBlocks.map((b) => b.id),
				explanation:
					"The task mentions result/output but never specifies the expected shape " +
					"(JSON schema, table, exit code), so success is uncheckable.",
				requiresEval: false,
				autoApplicable: false,
			}),
		];
	}
	return [];
}

/** Q08: task involves tools but no tool contract (when to call, side effects). */
export function q08ToolContract(manifest, ctx = {}) {
	const userBlocks = (manifest?.blocks ?? []).filter((b) => b.role === "user" || b.kind === "user_request");
	if (userBlocks.length === 0) return [];
	const job = userBlocks.map((b) => b.text).join("\n");
	const needsTool =
		TOOL_CONTRACT_MARKERS.some((re) => re.test(job)) ||
		/(?:run|执行|scan|查|查询|调用|build|构建|test|测试|编译)/i.test(job);
	if (!needsTool) return [];
	const hasContract =
		TOOL_CONTRACT_MARKERS.some((re) => re.test(job)) && /(?:side\s*effect|副作用|when|何时|失败|fallback|回退)/i.test(job);
	if (hasContract) return [];
	return [
		createFinding({
			ruleId: "Q08",
			title: "Tool contract unclear",
			severity: "MEDIUM",
			category: "QUALITY",
			blockIds: userBlocks.map((b) => b.id),
			explanation:
				"The task involves shell/tool work but never states when to call, whether a " +
				"tool has side effects, or how failures are handled.",
			requiresEval: false,
			autoApplicable: false,
		}),
	];
}

/** Q09: acceptance unverifiable ('very good', 'excellent'). */
export function q09UnverifiableAcceptance(manifest, ctx = {}) {
	const fuzzy = [
		{ re: /\b(?:very|really|super|excellent|perfect|high[- ]quality|advanced)\b/gi, label: "superlative" },
		{ re: /(效果|质量|高级|非常好|优秀|完美|极致)/gi, label: "中文最高级" },
	];
	const text = (manifest?.blocks ?? []).map((b) => b.text).join("\n");
	const hits = [];
	for (const { re, label } of fuzzy) {
		const ms = [...text.matchAll(re)];
		for (const m of ms.slice(0, 4)) hits.push({ label, match: m[0] });
	}
	if (hits.length === 0) return [];
	return [
		createFinding({
			ruleId: "Q09",
			title: "Unverifiable acceptance criteria",
			severity: "MEDIUM",
			category: "QUALITY",
			blockIds: (manifest?.blocks ?? []).filter((b) => b.role === "user" || b.kind === "user_request").map((b) => b.id),
			explanation:
				"Words like 'very good / high-quality' cannot be asserted by a test. Make " +
				"acceptance measurable (build passes, N tests, no regression, < X sec).",
			evidence: hits.map((h) => ({ text: `${h.label}: ${h.match}` })),
			requiresEval: false,
			autoApplicable: false,
		}),
	];
}

/**
 * Q10: resident rules overload — rules never used by most tasks are still
 * always injected. We approximate: overly long rule sections whose keywords
 * don't match the task. (True frequency analysis needs telemetry; this
 * heuristic only flags obvious cases.)
 */
export function q10ResidentRulesOverload(manifest, ctx = {}) {
	const rules = (manifest?.blocks ?? []).filter((b) => b.kind === "rule");
	if (rules.length === 0) return [];
	const total = rules.reduce((a, b) => a + b.tokenCount.count, 0);
	const max = rules.reduce((a, b) => (b.tokenCount.count > a.tokenCount.count ? b : a), rules[0]);
	if (max.tokenCount.count > 900 && max.tokenCount.count / (total || 1) > 0.5) {
		return [
			createFinding({
				ruleId: "Q10",
				title: `Rule block dominates prompt (${max.tokenCount.count} tokens)`,
				severity: "LOW",
				category: "QUALITY",
				blockIds: [max.id],
				explanation:
					"A single rule block carries most of the rules mass. If it only applies to a " +
					"minority of tasks, load it dynamically instead of every round.",
				evidence: [{ text: max.text.slice(0, 160) }],
				requiresEval: false,
				autoApplicable: false,
			}),
		];
	}
	return [];
}

/** Q11: negative instruction overload without positive defaults. */
export function q11NegativeOverload(manifest, ctx = {}) {
	const text = (manifest?.blocks ?? []).map((b) => b.text).join("\n");
	let negatives = 0;
	for (const re of NEGATIVE_OVERLOAD) negatives += (text.match(re) ?? []).length;
	if (negatives < 4) return [];
	const hasPositiveDefaults = /(?:instead|rather|do\s+this|换句话说|相反|应当|应该)/i.test(text);
	if (hasPositiveDefaults) return [];
	return [
		createFinding({
			ruleId: "Q11",
			title: `Negative instruction overload (${negatives} negations)`,
			severity: "LOW",
			category: "QUALITY",
			blockIds: (manifest?.blocks ?? []).map((b) => b.id),
			explanation:
				"Many 'don't' rules without positive defaults tend to be ignored or conflict. " +
				"Pair each prohibition with an explicit positive behavior.",
			requiresEval: false,
			autoApplicable: false,
		}),
	];
}

/** Q12 handled in duplicate-detector (schema dup). */

/**
 * Q13: a dynamic fact is written INTO a static rule file (spec §12 Q13 /
 * §13 dynamic-fact-in-static). Distinct from CACHE-003: that rule needs a
 * volatile *token* (timestamp, uuid); this one catches the plain-language
 * case — "current task: X", "today's focus", "当前分支" — where the content
 * changes every run but no parseable volatile token exists.
 */
const DYNAMIC_STATE_PATTERNS = [
	{ re: /\bcurrent\s+(?:task|sprint|branch|status|state|todo|focus|phase)\b/i, label: "current state" },
	{ re: /\b(?:today'?s?|this\s+week'?s?|right\s+now|as\s+of\s+now)\b/i, label: "time-relative" },
	{ re: /\b(?:pending|in\s+progress|blocked\s+by|wip)\b/i, label: "mutable status" },
	{ re: /(?:当前(?:任务|分支|状态|阶段)|正在(?:进行|处理|修复)|待办|本周)/, label: "当前状态" },
];

export function q13DynamicFactInStatic(manifest, ctx = {}) {
	const findings = [];
	for (const block of manifest?.blocks ?? []) {
		// Only blocks that CLAIM the stable region are interesting; a block
		// already classed DYNAMIC carries no false promise.
		if (declaredStability(block) !== "STATIC" && declaredStability(block) !== "MOSTLY_STATIC") continue;
		const hits = [];
		for (const { re, label } of DYNAMIC_STATE_PATTERNS) {
			const m = block.text.match(re);
			if (m) hits.push({ label, text: m[0] });
		}
		if (hits.length === 0) continue;
		findings.push(
			createFinding({
				ruleId: "Q13",
				title: "Dynamic fact written into a static rule",
				severity: "MEDIUM",
				category: "QUALITY",
				blockIds: [block.id],
				explanation:
					`This block lives in the static region but states a per-run fact ` +
					`(${hits.map((h) => h.label).join(", ")}). It changes every session while sitting in a ` +
					`region the provider expects to be byte-stable. Extract it to the dynamic region (spec §12 Q13).`,
				evidence: hits.map((h) => ({ label: h.label, text: h.text })),
				requiresEval: false,
				autoApplicable: false,
			}),
		);
	}
	return findings;
}

/** Q14: history pollution — old task conclusions read as current requirements. */
export function q14HistoryPollution(manifest, ctx = {}) {
	const blocks = manifest?.blocks ?? [];
	const findings = [];
	for (const b of blocks) {
		if (b.kind !== "history" && b.kind !== "tool_result") continue;
		const text = b.text;
		const decided = /(?:resolved|fixed|completed|done|closed|已修复|已完成|已解决|已关闭)/i.test(text);
		const commandTerms = /(?:now|current|please|务必|现在|请)/i.test(text);
		if (decided && commandTerms) {
			findings.push(
				createFinding({
					ruleId: "Q14",
					title: "Historic conclusion reads like a current requirement",
					severity: "MEDIUM",
					category: "QUALITY",
					blockIds: [b.id],
					explanation:
						"A concluded/closed result block is phrased as an imperative. Distinguish " +
						"instrumented evidence from current instructions.",
					evidence: [{ text: text.slice(0, 180) }],
					requiresEval: false,
					autoApplicable: false,
				}),
			);
		}
	}
	return findings.slice(0, 8);
}

/** Q15: coding tasks ask for completion without evidence (build/test/diff). */
export function q15EvidenceMissing(manifest, ctx = {}) {
	const userBlocks = (manifest?.blocks ?? []).filter((b) => b.role === "user" || b.kind === "user_request");
	if (userBlocks.length === 0) return [];
	const job = userBlocks.map((b) => b.text).join("\n");
	const isCoding = /(?:code|implement|refactor|fix|漏洞|bug|修复|重构|实现|代码|compile|build|test)/i.test(job);
	if (!isCoding) return [];
	const hasEvidence = /(?:build|test|verify|evidence|diff|pass|can\s+you\s+show|show\s+me|构建|测试|验证|证据|通过)/i.test(job);
	if (hasEvidence) return [];
	return [
		createFinding({
			ruleId: "Q15",
			title: "Coding task without evidence requirement",
			severity: "MEDIUM",
			category: "QUALITY",
			blockIds: userBlocks.map((b) => b.id),
			explanation:
				"The task only asks to 'complete' code. Add a verification contract: build " +
				"must pass, tests must target the change, and steps must be skippable.",
			requiresEval: false,
			autoApplicable: false,
		}),
	];
}

// Legacy boilerplate rule (kept for parity with earlier design versions).
export const qBoilerplateRule = {
	id: "Q-BOILERPLATE",
	title: "Persona boilerplate",
	category: "QUALITY",
	severity: "INFO",
	run(manifest) {
		const text = (manifest?.blocks ?? []).map((b) => b.text).join("\n");
		const hits = [];
		for (const re of HALLMARK_BOILERPLATE) {
			const ms = [...text.matchAll(re)];
			for (const m of ms.slice(0, 4)) hits.push(m[0]);
		}
		if (!hits.length) return [];
		return [createFinding({
			ruleId: "Q-BOILERPLATE",
			title: "AI boilerplate filler",
			severity: severityOfHtml(),
			category: "QUALITY",
			explanation: "Generic 'as an AI assistant' phrasing adds no constraint.",
			evidence: hits.map((t) => ({ text: t.slice(0, 80) })),
			requiresEval: false,
			autoApplicable: false,
		})];
	},
};

/**
 * All quality rules, ready for runRules(). Conflict rule (Q03) and duplicate
 * rules (Q04/Q12) are assembled here from their dedicated modules so the
 * manifest pipeline stays single-pass.
 */
export function qualityRules(manifest, ctx = {}) {
	return [
		...q01NoGoal(manifest, ctx),
		...q02VagueVerbs(manifest, ctx),
		...q05PersonaOverload(manifest, ctx),
		...q06PriorityMissing(manifest, ctx),
		...q07OutputContract(manifest, ctx),
		...q08ToolContract(manifest, ctx),
		...q09UnverifiableAcceptance(manifest, ctx),
		...q10ResidentRulesOverload(manifest, ctx),
		...q11NegativeOverload(manifest, ctx),
		...q13DynamicFactInStatic(manifest, ctx),
		...q14HistoryPollution(manifest, ctx),
		...q15EvidenceMissing(manifest, ctx),
	].filter(Boolean);
}