/**
 * Stability classification (spec §10) — round-1 gate #5/#6.
 *
 * The failure this guards against: a block carrying a live timestamp, UUID,
 * session id, git sha or absolute path being labelled STATIC, which then lets
 * the cache analyzer advertise a stable prefix that no provider could ever hit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrompt } from "../../lib/prompt-engine/parser.mjs";
import { detectVolatileSpans, stabilityFromContent } from "../../lib/prompt-engine/volatility.mjs";
import { classifyBlock, declaredStability } from "../../lib/prompt-engine/segment-classifier.mjs";
import { loadFixtures, fixtureById } from "./_helpers.mjs";

const STABLE = ["STATIC", "MOSTLY_STATIC"];

test("no block with volatile content is classified STATIC or MOSTLY_STATIC", () => {
	for (const { meta, content } of loadFixtures()) {
		const m = parsePrompt(content, { sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		for (const b of m.blocks) {
			const spans = detectVolatileSpans(b.text);
			if (spans.length === 0) continue;
			assert.ok(
				!STABLE.includes(b.stability),
				`${meta.id}: block ${b.kind} carries volatile content (${spans[0].label}) but is ${b.stability}`,
			);
		}
	}
});

test("each cache-killer fixture demotes at least one block off the stable region", () => {
	const killers = loadFixtures().filter((f) => f.meta.category === "cache-killer" && f.meta.id !== "D09-stable-baseline");
	assert.ok(killers.length >= 6, "not enough cache-killer fixtures to be meaningful");
	for (const { meta, content } of killers) {
		const m = parsePrompt(content, { sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		const demoted = m.blocks.filter((b) => b.stability === "DYNAMIC" || b.stability === "EPHEMERAL");
		assert.ok(demoted.length >= 1, `${meta.id}: nothing demoted — the killer was not detected`);
	}
});

test("timestamp / UUID / session / commit / branch / absolute path are individually volatile", () => {
	const cases = [
		["timestamp", "current_time: 2026-09-09T10:32:20Z"],
		["iso date", "build date 2026-09-09"],
		["uuid", "trace 7f1c2e90-4a4b-4c8d-9e2f-1a2b3c4d5e6f"],
		["session id", "session_id: req_9Xk2Lm4Qp7Rs"],
		["request id", "request_id: abc12345678"],
		["git sha", "commit: a4f1c9e2b7d3"],
		["branch", "branch: feature/prompt-lab"],
		["absolute path", "repo root: /home/administrator/work/repo"],
		["windows path", "workspace: C:\\Users\\Administrator\\work"],
		["epoch millis", "epoch_ms: 1789005140000"],
		["jwt", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_value_here"],
	];
	for (const [label, text] of cases) {
		assert.ok(detectVolatileSpans(text).length >= 1, `${label} not detected as volatile: ${text}`);
		assert.notEqual(stabilityFromContent(text, "STATIC"), "STATIC", `${label} kept STATIC`);
	}
});

test("stabilityFromContent only demotes, never promotes", () => {
	assert.equal(stabilityFromContent("plain static rule text", "EPHEMERAL"), "EPHEMERAL");
	assert.equal(stabilityFromContent("current_time: 2026-09-09T10:32:20Z", "MOSTLY_STATIC"), "EPHEMERAL");
	assert.equal(stabilityFromContent("- a rule\n- another rule\n- third rule\n- fourth rule\n", "STATIC"), "STATIC");
});

test("ordinary prose is NOT flagged volatile (no false positives)", () => {
	const prose = [
		"Use constructor injection instead of field injection.",
		"包结构按领域划分，不要按技术分层。",
		"package.json declares the workspace scripts.",
		"The mapper XML lives beside the mapper interface.",
	];
	for (const t of prose) {
		assert.equal(detectVolatileSpans(t).length, 0, `false volatile detection: ${t}`);
		assert.equal(stabilityFromContent(t, "STATIC"), "STATIC", `prose demoted: ${t}`);
	}
});

test("control fixture D09 stays fully static with zero prefix breakers", () => {
	const { meta, content } = fixtureById("D09-stable-baseline");
	const m = parsePrompt(content, { sourceType: meta.sourceType, provider: meta.provider });
	for (const b of m.blocks) {
		if (b.kind === "user_request" || b.role === "user") continue;
		assert.ok(STABLE.includes(b.stability), `${b.kind} should be stable, got ${b.stability}`);
		assert.equal(detectVolatileSpans(b.text).length, 0, `${b.kind} unexpectedly volatile`);
	}
});

test("classifyBlock reports both the declared and the effective class", () => {
	const { meta, content } = fixtureById("D01-timestamp-prefix");
	const m = parsePrompt(content, { sourceType: meta.sourceType, provider: meta.provider });
	const breaker = m.blocks.find((b) => detectVolatileSpans(b.text).length > 0);
	assert.ok(breaker, "no volatile block in D01");
	const cls = classifyBlock(breaker);
	assert.equal(cls.declared, declaredStability(breaker));
	assert.equal(cls.declared, "STATIC", "the kind table still claims STATIC — that is what makes it a breaker");
	assert.notEqual(cls.effective, "STATIC", "effective class must be demoted");
});
