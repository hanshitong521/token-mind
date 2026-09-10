/**
 * Canonicalizer (spec §9). The invariants that matter:
 *  - object key order may not affect identity when order is not semantic;
 *  - array order MUST affect identity (order is semantic);
 *  - whitespace normalization may never change code or SQL content.
 *
 * Getting either of these backwards silently corrupts the fingerprint: the
 * first hides real changes, the second invents fake ones.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	canonicalStringify,
	canonicalizeBlockText,
	canonicalManifest,
	normalizeLineEndings,
	trimTrailingWhitespace,
	sortKeysDeep,
} from "../../lib/prompt-engine/canonicalizer.mjs";
import { parsePrompt } from "../../lib/prompt-engine/parser.mjs";
import { segmentHash } from "../../lib/prompt-engine/fingerprint.mjs";

test("object key order does not affect the canonical form", () => {
	const a = { b: 1, a: { d: 2, c: 3 } };
	const b = { a: { c: 3, d: 2 }, b: 1 };
	assert.equal(canonicalStringify(a), canonicalStringify(b));
});

test("array order DOES affect the canonical form (order is semantic, §9.1)", () => {
	const a = { items: ["read_file", "grep", "run_tests"] };
	const b = { items: ["run_tests", "read_file", "grep"] };
	assert.notEqual(canonicalStringify(a), canonicalStringify(b));
});

test("sortKeysDeep recurses into arrays without reordering them", () => {
	const out = sortKeysDeep({ z: [{ b: 1, a: 2 }, { a: 1, b: 2 }] });
	assert.deepEqual(out.z[0], { a: 2, b: 1 });
	assert.deepEqual(out.z[1], { a: 1, b: 2 });
});

test("line endings are normalized: CRLF and CR both become LF", () => {
	assert.equal(normalizeLineEndings("a\r\nb\rc"), "a\nb\nc");
});

test("trailing whitespace is stripped per line, leading indentation is kept", () => {
	const src = "keep   \n    indented\n";
	const out = trimTrailingWhitespace(src);
	assert.equal(out, "keep\n    indented");
	assert.ok(out.includes("    indented"), "leading indentation must survive");
});

test("code fences survive canonicalization with their content intact", () => {
	const block = "```sql\nSELECT 1   \nFROM t;\n```";
	const out = canonicalizeBlockText(block);
	assert.ok(out.startsWith("```sql"), "fence marker lost");
	assert.ok(out.includes("SELECT 1"), "code content altered");
});

test("blank-line collapsing never eats the blank lines inside a fence", () => {
	const block = "text\n\n\n\n\n\n```\n\n\n\ncode\n\n\n\n```";
	const out = canonicalizeBlockText(block);
	const inside = out.slice(out.indexOf("```"));
	assert.ok(inside.includes("\n\n\n\ncode"), "blank lines inside a code fence were collapsed");
});

test("SQL and JSON literal content are byte-identical after canonicalization", () => {
	const sql = "SELECT o.id\nFROM t_order o\nWHERE o.status = 'PAID'";
	assert.equal(canonicalizeBlockText(sql), sql);
	const json = '{\n  "name": "read_file",\n  "required": ["path"]\n}';
	assert.equal(canonicalizeBlockText(json), json);
});

test("canonicalManifest preserves block order", () => {
	const m = parsePrompt("# Rules\n\n- one\n\n# Project\n\n- two\n", { sourceType: "markdown" });
	const c = canonicalManifest(m);
	assert.deepEqual(c.blocks.map((b) => b.kind), m.blocks.map((b) => b.kind));
});

test("canonicalManifest does not sort tools unless explicitly asked (§9.1)", () => {
	const tools = [{ name: "b" }, { name: "a" }];
	const m = { schemaVersion: "1.0", promptId: "p", sourceType: "tools", blocks: [], tools };
	const unsorted = canonicalManifest(m);
	assert.deepEqual(unsorted.tools.map((t) => t.name), ["b", "a"]);
	const sorted = canonicalManifest(m, { sortTools: true });
	assert.deepEqual(sorted.tools.map((t) => t.name), ["a", "b"]);
});

test("segment hash is order sensitive: reordering equal blocks changes the hash", () => {
	const m = parsePrompt('{"tools":[{"name":"a"},{"name":"b"}]}', { sourceType: "tools" });
	const forward = segmentHash(m.blocks);
	const reversed = segmentHash([...m.blocks].reverse());
	assert.notEqual(forward, reversed, "reordering was invisible to the segment hash");
});
