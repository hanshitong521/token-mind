/**
 * Fixture generator for Prompt Lab round 1 (spec §50 Step 0).
 *
 * Writes one file + one `.meta.json` per fixture into this directory.
 * Fixtures are a mix of:
 *  - REAL agent instruction files copied from the reference repos
 *    (A01 promptfoo AGENTS.md, A02 headroom llms.txt, A03 aider CONTRIBUTING.md);
 *  - targeted synthetic fixtures that isolate one property each
 *    (cache killers, DO_NOT_TOUCH classes, secrets, provider shapes).
 *
 * Re-runnable and deterministic: `node _generate-fixtures.mjs`.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = HERE;

const REFS = "C:/Users/Administrator/Downloads/44444444";
const REAL = [
	{ id: "A01-promptfoo-agents", src: `${REFS}/promptfoo-main/AGENTS.md`, ext: "md", note: "real 22KB AGENTS.md" },
	{ id: "A02-headroom-llms", src: `${REFS}/headroom-main/llms.txt`, ext: "txt", note: "real llms.txt" },
	{ id: "A03-aider-contributing", src: `${REFS}/aider-main/CONTRIBUTING.md`, ext: "md", note: "real CONTRIBUTING.md" },
];

const fixtures = [];
function fx({ id, category, ext = "md", sourceType, provider = null, content, expect = {}, secretValues = [] }) {
	fixtures.push({ id, category, ext, sourceType, provider, content, expect, secretValues });
}

// ─────────────────────────────────────────────────────────────
// A. Agent instruction files
// ─────────────────────────────────────────────────────────────
for (const r of REAL) {
	if (!existsSync(r.src)) {
		console.warn(`[skip] real fixture missing: ${r.src}`);
		continue;
	}
	fixtures.push({
		id: r.id,
		category: "agent-instruction",
		ext: r.ext,
		sourceType: "markdown",
		provider: "generic",
		content: readFileSync(r.src, "utf8"),
		expect: { minBlocks: 1, real: true },
		secretValues: [],
	});
}

fx({
	id: "A04-cursor-rules",
	category: "agent-instruction",
	ext: "mdc",
	sourceType: "cursor_rules",
	provider: "cursor",
	content: `---
description: Repo conventions for the Java service layer
globs: ["src/main/java/**/*.java"]
alwaysApply: true
---

# Rules

- Every public service method must declare its transaction boundary.
- Never catch Exception without rethrowing or logging the cause.
- Constructor injection only; field injection is not allowed.

# Project

Spring Boot with MyBatis. Mapper XML lives beside the mapper interface.
`,
	expect: { minBlocks: 2, ruleIds: [] },
});

fx({
	id: "A05-skill-md",
	category: "agent-instruction",
	sourceType: "skill_md",
	provider: "generic",
	content: `---
name: diagnose-bugs
description: Diagnose a hard bug or performance regression
---

# diagnose-bugs

## When to use
Use when a failure is reproducible but the cause is unknown.

## Procedure
1. Reproduce and capture the exact error.
2. Bisect the change range.
3. Confirm the root cause with a targeted experiment.
4. Fix, then verify with the original repro.

## Output
Report the root cause, the fix, and the evidence command output.
`,
	expect: { minBlocks: 3 },
});

fx({
	id: "A06-stable-core-prompt",
	category: "agent-instruction",
	sourceType: "system_prompt",
	provider: "openai",
	content: `# Core Rules

- Deterministic output only. Same input must produce the same plan.
- Prefer the smallest change that satisfies the requirement.
- State assumptions explicitly before acting.

# Project

Java service layer built on Spring Boot and MyBatis. Mapper XML sits beside
the mapper interface. Build with Maven, tests with JUnit.

# Tools

Use the search tool before editing a file you have not opened this session.
`,
	// Control fixture: nothing volatile, so nothing may be demoted and no
	// prefix breaker may be reported.
	expect: { minBlocks: 3, noStaticVolatile: true, allStableExceptUser: true, cacheBreakerMax: 0 },
});

fx({
	id: "A07-directive-conflict",
	category: "agent-instruction",
	sourceType: "markdown",
	provider: "generic",
	content: `# Rules

- 永远先问用户 before changing any public interface.
- 不要问问题，直接做 best effort when the request is unambiguous.

# Task

Rename the method.
`,
	expect: { minBlocks: 2, ruleIds: ["Q03-CONFLICT"] },
});

fx({
	id: "A08-vague-goal",
	category: "agent-instruction",
	sourceType: "markdown",
	provider: "generic",
	content: `# Background

The checkout service has been flaky since the last deploy and the team is not
sure whether the problem is the connection pool or the retry policy.

# Ask

请看看这个服务，考虑一下是不是连接池的问题，研究一下再给结论。
`,
	expect: { minBlocks: 2, ruleIds: ["Q01", "Q02"] },
});

fx({
	id: "A09-persona-and-negation",
	category: "agent-instruction",
	sourceType: "markdown",
	provider: "generic",
	content: `# Identity

你是世界顶级的资深架构师，是金牌专家，是大师级别的工程师。

# Constraints

禁止修改测试。
不要删除注释。
绝对不能改动数据库结构。
不能跳过代码评审。
`,
	expect: { minBlocks: 2, ruleIds: ["Q05", "Q11"] },
});

const DUP_RULE = `# Rules

- Deterministic ordering before every request.
- Never reorder arrays that carry sequence meaning.
- Keep the user request last.
`;
fx({
	id: "A10-duplicate-rule-blocks",
	category: "agent-instruction",
	sourceType: "markdown",
	provider: "generic",
	content: `${DUP_RULE}
${DUP_RULE}
`,
	expect: { minBlocks: 2, ruleIds: ["Q04-DUP-EXACT"] },
});

const LONG_RULE_LINES = Array.from(
	{ length: 60 },
	(_, i) =>
		`- Rule ${i + 1}: verify the deterministic ordering of every tool schema before the current user request is appended.`,
).join("\n");
fx({
	id: "A11-resident-rules-overload",
	category: "agent-instruction",
	sourceType: "markdown",
	provider: "generic",
	content: `# Rules

${LONG_RULE_LINES}

# Small Section

- Keep output concise.
`,
	expect: { minBlocks: 2, ruleIds: ["Q10"] },
});

// ─────────────────────────────────────────────────────────────
// B. Tool / MCP
// ─────────────────────────────────────────────────────────────
const TOOLS_A = {
	tools: [
		{ name: "read_file", description: "Read a UTF-8 text file from disk.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
		{ name: "grep", description: "Search the repository for a literal or regex pattern.", inputSchema: { type: "object", properties: { pattern: { type: "string" }, glob: { type: "string" } }, required: ["pattern"] } },
		{ name: "run_tests", description: "Run the test suite and return the summary.", inputSchema: { type: "object", properties: { selector: { type: "string" } }, required: [] } },
	],
};

fx({
	id: "B01-mcp-tools-list",
	category: "tool-mcp",
	ext: "json",
	sourceType: "tools",
	provider: "generic",
	content: JSON.stringify(TOOLS_A, null, 2),
	expect: { minBlocks: 3, kinds: ["tool_schema"] },
});

fx({
	id: "B02-duplicate-tool-schema",
	category: "tool-mcp",
	ext: "json",
	sourceType: "tools",
	provider: "generic",
	content: JSON.stringify(
		{
			tools: [
				TOOLS_A.tools[0],
				TOOLS_A.tools[1],
				{ ...TOOLS_A.tools[0] },
			],
		},
		null,
		2,
	),
	expect: { minBlocks: 3, ruleIds: ["Q12-SCHEMA-DUP", "CACHE-004"] },
});

// Same tools, different order — the fingerprint MUST change (spec §52).
fx({
	id: "B03-tools-order-swapped",
	category: "tool-mcp",
	ext: "json",
	sourceType: "tools",
	provider: "generic",
	content: JSON.stringify({ tools: [TOOLS_A.tools[2], TOOLS_A.tools[0], TOOLS_A.tools[1]] }, null, 2),
	expect: { minBlocks: 3, fingerprintDiffFrom: "B01-mcp-tools-list", fingerprintSameSegments: ["system", "rules"] },
});

fx({
	id: "B05-huge-tool-description",
	category: "tool-mcp",
	ext: "json",
	sourceType: "tools",
	provider: "generic",
	content: JSON.stringify(
		{
			tools: [
				{
					name: "aggregate_metrics",
					description:
						"Aggregate per-service latency, error rate and saturation counters across the fleet. " +
						"Supports grouping by service, region and deployment. Results are approximate when the " +
						"window exceeds one hour, in which case the response contains a sampling notice. " +
						"Prefer this tool over reading raw timeseries when you only need a summary. ".repeat(6),
					inputSchema: { type: "object", properties: { window: { type: "string" }, groupBy: { type: "array", items: { type: "string" } } }, required: ["window"] },
				},
			],
		},
		null,
		2,
	),
	expect: { minBlocks: 1, minTokens: 200 },
});

fx({
	id: "B06-dynamic-tool-description",
	category: "tool-mcp",
	ext: "json",
	sourceType: "tools",
	provider: "generic",
	content: JSON.stringify(
		{
			tools: [
				{
					name: "current_deploy_status",
					description: "Live deploy status refreshed at 2026-09-09T10:32:20Z for build 8f14e45f.",
					inputSchema: { type: "object", properties: { env: { type: "string" } }, required: ["env"] },
				},
			],
		},
		null,
		2,
	),
	expect: { minBlocks: 1, noStaticVolatile: true },
});

fx({
	id: "B07-inline-schema-duplicate",
	category: "tool-mcp",
	sourceType: "markdown",
	provider: "generic",
	content: `# Tools

\`\`\`json
{"name":"read_file","description":"Read a UTF-8 text file from disk.","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}
\`\`\`

The same schema is also pasted below as prose documentation.

\`\`\`json
{"name":"read_file","description":"Read a UTF-8 text file from disk.","inputSchema":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}
\`\`\`
`,
	expect: { minBlocks: 1, ruleIds: ["Q12-SCHEMA-DUP"] },
});

// ─────────────────────────────────────────────────────────────
// C. Provider request shapes
// ─────────────────────────────────────────────────────────────
fx({
	id: "C01-openai-messages",
	category: "provider",
	ext: "json",
	sourceType: "openai",
	provider: "openai",
	content: JSON.stringify(
		{
			model: "gpt-5-mini",
			messages: [
				{ role: "system", content: "You are a careful coding assistant. Prefer the smallest correct change." },
				{ role: "user", content: "Refactor OrderService to use constructor injection and run the unit tests." },
				{ role: "assistant", content: "I will change the field injection to constructor injection first." },
			],
		},
		null,
		2,
	),
	expect: { minBlocks: 3 },
});

fx({
	id: "C02-anthropic-request",
	category: "provider",
	ext: "json",
	sourceType: "anthropic",
	provider: "anthropic",
	content: JSON.stringify(
		{
			model: "claude-sonnet-4-5",
			system: "You are a careful coding assistant. Never modify tests to make them pass.",
			messages: [{ role: "user", content: "Locate the NPE in the payment callback and fix the root cause." }],
			tools: [TOOLS_A.tools[0], TOOLS_A.tools[1]],
		},
		null,
		2,
	),
	expect: { minBlocks: 3 },
});

fx({
	id: "C03-openai-compatible-qwen",
	category: "provider",
	ext: "json",
	sourceType: "openai",
	provider: "qwen",
	content: JSON.stringify(
		{
			model: "qwen2.5-coder-32b",
			messages: [
				{ role: "system", content: "本地 Qwen 模型，请严格使用中文回复，代码注释保持中文。" },
				{ role: "user", content: "把这段 MyBatis XML 改成批量插入，并给出验证步骤。" },
			],
		},
		null,
		2,
	),
	expect: { minBlocks: 2 },
});

fx({
	id: "C04-openai-history-and-tool-results",
	category: "provider",
	ext: "json",
	sourceType: "openai",
	provider: "openai",
	content: JSON.stringify(
		{
			model: "gpt-5-mini",
			messages: [
				{ role: "system", content: "You are a coding assistant." },
				{ role: "user", content: "Fix the failing mapper test." },
				{ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "run_tests", arguments: "{\"selector\":\"MapperTest\"}" } }] },
				{ role: "tool", content: "FAILURE: expected 3 rows but found 2\n\tat MapperTest.insertBatch" },
				{ role: "user", content: "The batch insert loses the last row. Fix it and re-run the test." },
			],
		},
		null,
		2,
	),
	expect: { minBlocks: 4 },
});

fx({
	id: "C05-anthropic-tool-use",
	category: "provider",
	ext: "json",
	sourceType: "anthropic",
	provider: "anthropic",
	content: JSON.stringify(
		{
			model: "claude-sonnet-4-5",
			system: "You are a coding assistant with tool access.",
			messages: [
				{ role: "user", content: "Inspect the failing build log." },
				{ role: "assistant", content: [{ type: "tool_use", name: "read_file", input: { path: "build.log" } }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "error: cannot find symbol" }] },
			],
			tools: [TOOLS_A.tools[0]],
		},
		null,
		2,
	),
	expect: { minBlocks: 3 },
});

fx({
	id: "C06-local-qwen-agent",
	category: "provider",
	ext: "json",
	sourceType: "openai",
	provider: "qwen",
	content: JSON.stringify(
		{
			model: "qwen2.5-72b-instruct",
			messages: [
				{ role: "system", content: "<|im_start|>system\n你是本地部署的编码助手。<|im_end|>" },
				{ role: "user", content: "为 OrderController 增加分页参数校验，并补充边界测试。" },
			],
		},
		null,
		2,
	),
	expect: { minBlocks: 2 },
});

// ─────────────────────────────────────────────────────────────
// D. Cache killers
// ─────────────────────────────────────────────────────────────
const cacheKiller = (id, title, body) =>
	fx({
		id,
		category: "cache-killer",
		sourceType: "markdown",
		provider: "cursor",
		content: `# Core Rules

- Deterministic output only.
- Prefer the smallest correct change.

# ${title}

${body}

# User Request

Refactor the parser and verify the tests pass.
`,
		expect: { minBlocks: 3, noStaticVolatile: true, minNonStatic: 1 },
	});

cacheKiller("D01-timestamp-prefix", "Runtime", "current_time: 2026-09-09T10:32:20Z");
cacheKiller("D02-uuid-session", "Runtime", "trace id 7f1c2e90-4a4b-4c8d-9e2f-1a2b3c4d5e6f");
cacheKiller("D03-request-ids", "Runtime", "request_id: req_9Xk2Lm4Qp7Rs\nspan_id: span_3Bn8Vc1Zq5Wt");
cacheKiller("D04-git-commit-branch", "Repository State", "commit: a4f1c9e2b7d3\nbranch: feature/prompt-lab-round1");
cacheKiller("D05-absolute-paths", "Workspace", "repo root: /home/administrator/work/A-skill/Token-Mind");
cacheKiller("D06-epoch-and-hash", "Runtime", "epoch_ms: 1789005140000\nbuild digest: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");

fx({
	id: "D07-dynamic-memory-early",
	category: "cache-killer",
	ext: "json",
	sourceType: "openai",
	provider: "openai",
	content: JSON.stringify(
		{
			model: "gpt-5-mini",
			messages: [
				{ role: "system", content: "Memory retrieved at 2026-09-09T10:32:20Z: the team prefers constructor injection; last incident was a connection pool leak." },
				{ role: "system", content: "You are a careful coding assistant." },
				{ role: "user", content: "Refactor OrderService." },
			],
		},
		null,
		2,
	),
	expect: { minBlocks: 3, noStaticVolatile: true, firstDynamicIsFirstBlock: true },
});

fx({
	id: "D08-dynamic-rag-early",
	category: "cache-killer",
	ext: "json",
	sourceType: "openai",
	provider: "openai",
	content: JSON.stringify(
		{
			model: "gpt-5-mini",
			messages: [
				{ role: "system", content: "Retrieved documents for query 41b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d: doc_1 ... doc_2 ..." },
				{ role: "system", content: "Answer using only the retrieved documents." },
				{ role: "user", content: "Summarise the retrieved documents." },
			],
		},
		null,
		2,
	),
	expect: { minBlocks: 3, noStaticVolatile: true },
});

fx({
	id: "D09-stable-baseline",
	category: "cache-killer",
	sourceType: "markdown",
	provider: "cursor",
	content: `# Core Rules

- Deterministic output only.
- Prefer the smallest correct change.
- Keep the user request last.

# Project

Spring Boot service layer with MyBatis mappers and JUnit tests.

# User Request

Refactor the parser and verify the tests pass.
`,
	// Control: zero volatility means zero breakers and no demotion.
	expect: { minBlocks: 3, noStaticVolatile: true, allStableExceptUser: true, cacheBreakerMax: 0 },
});

// ─────────────────────────────────────────────────────────────
// E. DO_NOT_TOUCH
// ─────────────────────────────────────────────────────────────
fx({
	id: "E01-sql",
	category: "dont-touch",
	sourceType: "markdown",
	provider: "generic",
	content: `# Migration

Run this SQL exactly as written:

\`\`\`sql
SELECT o.order_id, o.created_at, u.email
FROM t_order o
JOIN t_user u ON u.user_id = o.user_id
WHERE o.status = 'PAID';
\`\`\`
`,
	expect: { minBlocks: 1, minDoNotTouch: 1, roundTrip: true },
});

fx({
	id: "E02-json-schema",
	category: "dont-touch",
	sourceType: "markdown",
	provider: "generic",
	content: `# Tool Contract

\`\`\`json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "recursive": { "type": "boolean" }
  },
  "required": ["path"]
}
\`\`\`
`,
	expect: { minBlocks: 1, minDoNotTouch: 1, roundTrip: true },
});

fx({
	id: "E03-code-diff",
	category: "dont-touch",
	sourceType: "markdown",
	provider: "generic",
	content: `# Patch

\`\`\`diff
--- a/src/main/java/OrderService.java
+++ b/src/main/java/OrderService.java
@@ -18,7 +18,9 @@ public class OrderService {
-    @Autowired private OrderMapper orderMapper;
+    private final OrderMapper orderMapper;
+    public OrderService(OrderMapper orderMapper) { this.orderMapper = orderMapper; }
\`\`\`
`,
	expect: { minBlocks: 1, minDoNotTouch: 1, roundTrip: true },
});

fx({
	id: "E04-acceptance-and-danger",
	category: "dont-touch",
	sourceType: "markdown",
	provider: "generic",
	content: `# Acceptance Criteria

- Build passes.
- All mapper tests pass.
- No production schema change.

# Safety

Never run rm -rf against the production volume. Deployment is read-only for
agents; a human must apply any schema migration.
`,
	expect: { minBlocks: 2, allDoNotTouch: true },
});

fx({
	id: "E05-user-request-original",
	category: "dont-touch",
	sourceType: "user_prompt",
	provider: "generic",
	content: `Current user request:

把 OrderController 的分页参数加上校验，必须保留现有的错误码，验收标准是单测全绿并且构建通过。
`,
	expect: { minBlocks: 1, allDoNotTouch: true },
});

// ─────────────────────────────────────────────────────────────
// F. Security (all values are fake)
// ─────────────────────────────────────────────────────────────
fx({
	id: "F01-api-keys",
	category: "security",
	sourceType: "markdown",
	provider: "generic",
	content: `# Environment

OPENAI_API_KEY=sk-proj-9Xt2Lm4Qp7Rs8Tu1Vw2Xy3Z4a5B6c7D8e9F0g1H2i3J4k5L6m7N8o9P0
ANTHROPIC_KEY=sk-ant-api03-AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789

Use these when calling the gateway.
`,
	secretValues: [
		"sk-proj-9Xt2Lm4Qp7Rs8Tu1Vw2Xy3Z4a5B6c7D8e9F0g1H2i3J4k5L6m7N8o9P0",
		"sk-ant-api03-AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789",
	],
	expect: { minBlocks: 1, secrets: true, secretKinds: ["api_key"] },
});

fx({
	id: "F02-bearer-and-cookie",
	category: "security",
	sourceType: "markdown",
	provider: "generic",
	content: `# Headers

Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U
Cookie: sessionid=8f14e45fceea167a5a36dedd4bea2543
`,
	secretValues: [
		"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
		"8f14e45fceea167a5a36dedd4bea2543",
	],
	expect: { minBlocks: 1, secrets: true, secretKinds: ["bearer_token", "cookie"] },
});

fx({
	id: "F03-password-and-private-key",
	category: "security",
	sourceType: "markdown",
	provider: "generic",
	content: `# Database

password: Sup3rS3cretValue

# Deploy key

-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA7xKp2mQ9vL1nR4tY8uI0oP3aS5dF6gH7jK8lZ9xC0vB1nM2qW3e
-----END RSA PRIVATE KEY-----
`,
	secretValues: ["Sup3rS3cretValue"],
	expect: { minBlocks: 1, secrets: true, secretKinds: ["password", "private_key"] },
});

fx({
	id: "F04-access-token-and-db-url",
	category: "security",
	sourceType: "markdown",
	provider: "generic",
	content: `# Runtime

access_token: ghp_16C7e42F292c6912E7710c838347Ae178B4a
DATABASE_URL=postgres://admin:ExamplePass123@db.internal.example.com:5432/orders
`,
	secretValues: ["ghp_16C7e42F292c6912E7710c838347Ae178B4a", "ExamplePass123"],
	expect: { minBlocks: 1, secrets: true, secretKinds: ["access_token", "database_url"] },
});

// ─────────────────────────────────────────────────────────────
// Write out
// ─────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const manifest = [];
for (const f of fixtures) {
	const file = `${f.id}.${f.ext}`;
	writeFileSync(join(OUT, file), f.content, "utf8");
	const meta = {
		id: f.id,
		file,
		category: f.category,
		sourceType: f.sourceType ?? null,
		provider: f.provider ?? null,
		bytes: Buffer.byteLength(f.content, "utf8"),
		expect: f.expect,
		secretValues: f.secretValues,
	};
	writeFileSync(join(OUT, `${f.id}.meta.json`), JSON.stringify(meta, null, 2) + "\n", "utf8");
	manifest.push(meta);
}
writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ count: manifest.length, fixtures: manifest }, null, 2) + "\n", "utf8");
console.log(`fixtures written: ${manifest.length}`);
for (const m of manifest) console.log(`  ${m.category.padEnd(18)} ${m.id}`);
