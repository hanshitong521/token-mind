/**
 * Round-trip: Prompt → IR → serialize → Prompt'.
 *
 * Spec §61 acceptance #3: for DO_NOT_TOUCH content, key semantics / key bytes
 * must be 100% preserved. We assert this on all three serializers, not just
 * markdown, because the dangerous case is a schema or SQL statement silently
 * re-shaped on the way to a provider request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parsePrompt,
	serializeToMarkdown,
	serializeToMessages,
	serializeToAnthropic,
} from "../../lib/prompt-engine/parser.mjs";
import { untouchableLabels } from "../../lib/prompt-engine/parser.mjs";
import { loadFixtures } from "./_helpers.mjs";

const DO_NOT_TOUCH_FIXTURES = ["E01-sql", "E02-json-schema", "E03-code-diff", "E04-acceptance-and-danger", "E05-user-request-original"];

function manifestOf(id) {
	const all = loadFixtures();
	const f = all.find((x) => x.meta.id === id);
	if (!f) throw new Error(`missing fixture ${id}`);
	return parsePrompt(f.content, { sourceType: f.meta.sourceType ?? undefined, provider: f.meta.provider });
}

test("every DO_NOT_TOUCH fixture actually contains DO_NOT_TOUCH blocks", () => {
	for (const id of DO_NOT_TOUCH_FIXTURES) {
		const m = manifestOf(id);
		const dnt = m.blocks.filter((b) => b.mutability === "DO_NOT_TOUCH");
		assert.ok(dnt.length >= 1, `${id}: no DO_NOT_TOUCH block — fixture is not testing what it claims`);
	}
});

test("markdown export preserves every DO_NOT_TOUCH block byte-for-byte", () => {
	for (const id of DO_NOT_TOUCH_FIXTURES) {
		const m = manifestOf(id);
		const md = serializeToMarkdown(m);
		for (const b of m.blocks.filter((x) => x.mutability === "DO_NOT_TOUCH")) {
			assert.ok(md.includes(b.text), `${id}: markdown export lost DO_NOT_TOUCH block ${b.kind}`);
		}
	}
});

test("OpenAI messages export preserves every DO_NOT_TOUCH block byte-for-byte", () => {
	for (const id of DO_NOT_TOUCH_FIXTURES) {
		const m = manifestOf(id);
		const messages = serializeToMessages(m);
		const joined = messages.map((x) => x.content).join("\n");
		for (const b of m.blocks.filter((x) => x.mutability === "DO_NOT_TOUCH")) {
			assert.ok(joined.includes(b.text), `${id}: messages export lost DO_NOT_TOUCH block ${b.kind}`);
		}
	}
});

test("Anthropic export preserves every DO_NOT_TOUCH block byte-for-byte", () => {
	for (const id of DO_NOT_TOUCH_FIXTURES) {
		const m = manifestOf(id);
		const req = serializeToAnthropic(m);
		const joined = `${req.system}\n${req.messages.map((x) => x.content).join("\n")}`;
		for (const b of m.blocks.filter((x) => x.mutability === "DO_NOT_TOUCH")) {
			assert.ok(joined.includes(b.text), `${id}: anthropic export lost DO_NOT_TOUCH block ${b.kind}`);
		}
	}
});

test("re-parsing the exported markdown preserves DO_NOT_TOUCH classification", () => {
	for (const id of DO_NOT_TOUCH_FIXTURES) {
		const m = manifestOf(id);
		const before = m.blocks.filter((b) => b.mutability === "DO_NOT_TOUCH");
		const again = parsePrompt(serializeToMarkdown(m), { sourceType: "markdown" });
		const after = again.blocks.filter((b) => b.mutability === "DO_NOT_TOUCH");
		assert.ok(
			after.length >= before.length,
			`${id}: round-trip lost DO_NOT_TOUCH blocks (before ${before.length}, after ${after.length})`,
		);
		// and the §15 labels that made them untouchable are still detectable
		for (const b of before) {
			const labels = untouchableLabels(b.text);
			if (labels.length === 0) continue; // kind-based DNT (e.g. user_request)
			const stillFound = again.blocks.some((x) => untouchableLabels(x.text).length > 0);
			assert.ok(stillFound, `${id}: §15 labels (${labels.join(",")}) not recoverable after round-trip`);
		}
	}
});

test("round-trip does not change the token total of DO_NOT_TOUCH content", () => {
	for (const id of DO_NOT_TOUCH_FIXTURES) {
		const m = manifestOf(id);
		const before = m.blocks.filter((b) => b.mutability === "DO_NOT_TOUCH").reduce((a, b) => a + b.tokenCount.count, 0);
		const again = parsePrompt(serializeToMarkdown(m), { sourceType: "markdown" });
		const after = again.blocks.filter((b) => b.mutability === "DO_NOT_TOUCH").reduce((a, b) => a + b.tokenCount.count, 0);
		assert.ok(after >= before, `${id}: DO_NOT_TOUCH token mass shrank (${before} → ${after}) — content was dropped`);
	}
});
