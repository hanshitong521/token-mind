/**
 * Cache Stability Analyzer (spec §11, §54).
 *
 * §11.3 requires five numbers; §54 requires four named regression scenarios
 * (A trailing user change, B leading timestamp, C tool reordering, D dynamic
 * content bleeding into the stable region). This file pins both.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrompt } from "../../lib/prompt-engine/parser.mjs";
import { analyzeCacheStability, compareCacheRegression, cacheStabilityScore } from "../../lib/prompt-engine/cache-analyzer.mjs";
import { analyze } from "../../lib/prompt-engine/index.mjs";
import { detectVolatileSpans } from "../../lib/prompt-engine/volatility.mjs";
import { loadFixtures, fixtureById } from "./_helpers.mjs";

const RULES = "# Core Rules\n\n- Deterministic output only.\n- Prefer the smallest correct change.\n";
const PROJECT = "# Project\n\nSpring Boot with MyBatis mappers and JUnit tests.\n";
const MEMORY = "# Retrieved Memory\n\nCurrent memory (retrieved 2026-09-09T10:32:20Z): the team prefers constructor injection.\n";

function m(md, opts = {}) {
	return parsePrompt(md, { sourceType: "markdown", ...opts });
}

test("§11.3 five metrics are present and correctly typed", () => {
	for (const { meta, content } of loadFixtures()) {
		const r = analyze({ content, sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		const c = r.cache;
		assert.equal(typeof c.totalTokens, "number", `${meta.id}: totalTokens`);
		assert.equal(typeof c.stablePrefixTokens, "number", `${meta.id}: stablePrefixTokens`);
		assert.equal(typeof c.stablePrefixRatio, "number", `${meta.id}: stablePrefixRatio`);
		assert.ok(c.stablePrefixRatio >= 0 && c.stablePrefixRatio <= 1, `${meta.id}: ratio out of range`);
		assert.ok("firstDynamicBlock" in c, `${meta.id}: firstDynamicBlock missing`);
		assert.ok("firstDynamicTokenOffset" in c, `${meta.id}: firstDynamicTokenOffset missing`);
		assert.equal(typeof c.cacheBreakerCount, "number", `${meta.id}: cacheBreakerCount`);
	}
});

test("stable prefix never exceeds total tokens", () => {
	for (const { meta, content } of loadFixtures()) {
		const c = analyzeCacheStability(parsePrompt(content, { sourceType: meta.sourceType ?? undefined, provider: meta.provider }));
		assert.ok(c.stablePrefixTokens <= c.totalTokens, `${meta.id}: prefix ${c.stablePrefixTokens} > total ${c.totalTokens}`);
	}
});

// ── §54 Case A ────────────────────────────────────────────────
test("§54 A — changing only the trailing user request keeps the stable prefix", () => {
	const base = m(`${RULES}\n${PROJECT}\n# User Request\n\nRefactor the parser.\n`);
	const other = m(`${RULES}\n${PROJECT}\n# User Request\n\nRewrite the serializer instead, keep behaviour identical.\n`);
	const a = analyzeCacheStability(base);
	const b = analyzeCacheStability(other);
	assert.equal(a.stablePrefixTokens, b.stablePrefixTokens, "prefix moved on a user-only edit");
	// firstDynamicBlock ids are content-addressed, so they legitimately move with
	// the user text; what must not move is the prefix boundary itself.
	assert.equal(a.firstDynamicTokenOffset, b.firstDynamicTokenOffset, 'prefix boundary moved');
	const reg = compareCacheRegression(base, other);
	assert.equal(reg.regression, false, "user-only edit reported as a cache regression");
});

// ── §54 Case B ────────────────────────────────────────────────
test("§54 B — a timestamp at the front is reported as a cache breaker", () => {
	const base = m(`${RULES}\n${PROJECT}\n# User Request\n\nRefactor the parser.\n`);
	const poisoned = m(`# Runtime\n\ncurrent_time: 2026-09-09T10:32:20Z\n\n${RULES}\n${PROJECT}\n# User Request\n\nRefactor the parser.\n`);
	const a = analyzeCacheStability(base);
	const b = analyzeCacheStability(poisoned);
	assert.ok(a.stablePrefixTokens > 0, "baseline should have a usable prefix");
	assert.equal(b.firstDynamicBlock, b.manifestFirst ?? poisoned.blocks[0].id, "first block should be the breaker");
	assert.ok(b.cacheBreakerCount >= 1, "no CACHE_PREFIX_BREAKER reported");
	assert.ok(b.stablePrefixTokens < a.stablePrefixTokens, "prefix did not shrink");
	const reg = compareCacheRegression(base, poisoned);
	assert.equal(reg.regression, true, "leading timestamp not reported as regression");
});

test("§54 B — the engine surfaces the breaker as a CACHE-001 finding", () => {
	const poisoned = `current_time: 2026-09-09T10:32:20Z\n\n${RULES}`;
	const r = analyze({ content: poisoned, sourceType: "markdown", provider: "cursor" });
	assert.ok(r.findings.some((f) => f.ruleId === "CACHE-001"), "CACHE-001 did not fire");
	const breaker = r.findings.find((f) => f.ruleId === "CACHE-001");
	assert.equal(breaker.severity, "HIGH");
	assert.ok(breaker.evidence.length >= 1, "breaker finding has no evidence spans");
});

// ── §54 Case C ────────────────────────────────────────────────
test("§54 C — tool content unchanged but reordered is detected", () => {
	const a = fixtureById("B01-mcp-tools-list");
	const b = fixtureById("B03-tools-order-swapped");
	const ma = parsePrompt(a.content, { sourceType: a.meta.sourceType });
	const mb = parsePrompt(b.content, { sourceType: b.meta.sourceType });
	const ra = analyze({ content: a.content, sourceType: a.meta.sourceType });
	const rb = analyze({ content: b.content, sourceType: b.meta.sourceType });
	// same tool set, different serialisation ⇒ different fingerprint
	assert.notEqual(ra.fingerprint.segments.tools, rb.fingerprint.segments.tools, "reorder invisible");
	// but the same token mass, so a "we saved tokens" claim would be a lie
	assert.equal(ra.tokens.PromptTotal, rb.tokens.PromptTotal, "reorder changed token count unexpectedly");
	assert.equal(ma.blocks.length, mb.blocks.length);
});

test("§54 C — non-contiguous tool schemas are reported by CACHE-002", () => {
	const tool = '```json\n{"name":"read_file","description":"Read a file.","inputSchema":{"type":"object"}}\n```';
	const interleaved = `# Tools\n\n${tool}\n\n# Rules\n\n- keep deterministic\n\n# Tools\n\n${tool}\n`;
	const r = analyze({ content: interleaved, sourceType: "markdown", provider: "generic" });
	assert.ok(r.findings.some((f) => f.ruleId === "CACHE-002"), "CACHE-002 did not fire for non-contiguous tools");
});

// ── §54 Case D ────────────────────────────────────────────────
test("§54 D — dynamic memory moved into the stable region is detected and hurts the prefix", () => {
	const late = m(`${RULES}\n${PROJECT}\n${MEMORY}\n# User Request\n\nRefactor the parser.\n`);
	const early = m(`${MEMORY}\n${RULES}\n${PROJECT}\n# User Request\n\nRefactor the parser.\n`);
	const a = analyzeCacheStability(late);
	const b = analyzeCacheStability(early);
	assert.ok(b.stablePrefixTokens < a.stablePrefixTokens, `prefix did not shrink (${a.stablePrefixTokens} → ${b.stablePrefixTokens})`);
	assert.ok(b.cacheBreakerCount >= 1, "no breaker reported for dynamic-in-static");
	const reg = compareCacheRegression(late, early);
	assert.equal(reg.regression, true, "dynamic-in-stable not reported as regression");
});

test("§54 D — the engine names the breaker with a rule id and block id", () => {
	const early = `${MEMORY}\n${RULES}`;
	const r = analyze({ content: early, sourceType: "markdown", provider: "cursor" });
	const breaker = r.findings.find((f) => f.ruleId === "CACHE-001" || f.ruleId === "CACHE-003");
	assert.ok(breaker, `no cache rule fired, got [${r.findings.map((f) => f.ruleId).join(",")}]`);
	assert.ok(breaker.blockIds.length >= 1, "breaker finding has no block reference");
});

test("cache stability score is 0..100 and always reports its dimensions", () => {
	for (const { meta, content } of loadFixtures()) {
		const manifest = parsePrompt(content, { sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		const s = cacheStabilityScore(manifest);
		assert.ok(s.score >= 0 && s.score <= 100, `${meta.id}: score ${s.score}`);
		for (const dim of ["stable_prefix_ratio", "early_volatility", "deterministic_ordering", "dynamic_isolation", "tool_schema_stability"]) {
			assert.ok(dim in s.dimensions, `${meta.id}: missing dimension ${dim}`);
		}
	}
});

test("a fully static prompt scores higher than the same prompt with a leading timestamp", () => {
	const clean = cacheStabilityScore(m(`${RULES}\n${PROJECT}\n# User Request\n\nRefactor the parser.\n`)).score;
	const poisoned = cacheStabilityScore(m(`# Runtime\n\ncurrent_time: 2026-09-09T10:32:20Z\n\n${RULES}\n${PROJECT}\n# User Request\n\nRefactor the parser.\n`)).score;
	assert.ok(poisoned < clean, `poisoned (${poisoned}) should score below clean (${clean})`);
});

test("volatility is attributed to the block that actually carries it", () => {
	const manifest = m(`${RULES}\n# Runtime\n\ncurrent_time: 2026-09-09T10:32:20Z\n`);
	const c = analyzeCacheStability(manifest);
	const breaker = manifest.blocks.find((b) => b.id === c.firstDynamicBlock);
	assert.ok(breaker);
	assert.ok(detectVolatileSpans(breaker.text).length >= 1, "the block named as breaker carries no volatile span");
});
