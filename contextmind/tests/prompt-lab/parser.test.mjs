import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrompt, serializeToMarkdown, splitMarkdownBlocks } from "../../lib/prompt-engine/parser.mjs";
import { BLOCK_KINDS, BLOCK_ROLES, STABILITIES, MUTABILITIES, PRIORITIES } from "../../lib/prompt-engine/manifest.mjs";
import { analyze } from "../../lib/prompt-engine/index.mjs";
import { runRulesWithReport } from "../../lib/prompt-engine/rule-engine.mjs";
import { analyzeCacheStability } from "../../lib/prompt-engine/cache-analyzer.mjs";
import { scoreManifest } from "../../lib/prompt-engine/scoring.mjs";
import { computeFingerprint } from "../../lib/prompt-engine/fingerprint.mjs";
import { redactManifestBlocks } from "../../lib/prompt-engine/secrets.mjs";
import { allRules } from "../../lib/prompt-engine/index.mjs";
import { loadFixtures, fixtureById, deepFreeze } from "./_helpers.mjs";

test("every fixture parses without throwing and yields at least one block", () => {
	for (const { meta, content } of loadFixtures()) {
		const manifest = parsePrompt(content, { sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		assert.ok(manifest.blocks.length >= 1, `${meta.id}: no blocks parsed`);
		if (meta.expect.minBlocks) {
			assert.ok(manifest.blocks.length >= meta.expect.minBlocks, `${meta.id}: blocks < ${meta.expect.minBlocks}`);
		}
	}
});

test("parse is deterministic: same input ⇒ identical block ids, order and hashes", () => {
	for (const { meta, content } of loadFixtures()) {
		const a = parsePrompt(content, { sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		const b = parsePrompt(content, { sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		assert.deepEqual(a.blocks.map((x) => x.id), b.blocks.map((x) => x.id), `${meta.id}: block ids not stable`);
		assert.deepEqual(a.blocks.map((x) => x.hash), b.blocks.map((x) => x.hash), `${meta.id}: hashes not stable`);
	}
});

test("block enums stay inside the declared Prompt IR vocabulary", () => {
	for (const { meta, content } of loadFixtures()) {
		const manifest = parsePrompt(content, { sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		for (const b of manifest.blocks) {
			assert.ok(BLOCK_KINDS.includes(b.kind), `${meta.id}: unknown kind ${b.kind}`);
			assert.ok(BLOCK_ROLES.includes(b.role), `${meta.id}: unknown role ${b.role}`);
			assert.ok(STABILITIES.includes(b.stability), `${meta.id}: unknown stability ${b.stability}`);
			assert.ok(MUTABILITIES.includes(b.mutability), `${meta.id}: unknown mutability ${b.mutability}`);
			assert.ok(PRIORITIES.includes(b.priority), `${meta.id}: unknown priority ${b.priority}`);
		}
	}
});

test("markdown code fences are never split across blocks", () => {
	for (const id of ["E01-sql", "E02-json-schema", "E03-code-diff"]) {
		const { meta, content } = fixtureById(id);
		const manifest = parsePrompt(content, { sourceType: meta.sourceType });
		const fenced = manifest.blocks.filter((b) => b.text.includes("```"));
		assert.ok(fenced.length >= 1, `${id}: no fenced block survived parsing`);
		for (const b of fenced) {
			const opens = (b.text.match(/```/g) ?? []).length;
			assert.equal(opens % 2, 0, `${id}: unbalanced fence (${opens} markers) means the fence was split`);
		}
	}
});

test("tool schemas stay parseable JSON after parsing", () => {
	for (const id of ["B01-mcp-tools-list", "B02-duplicate-tool-schema", "B06-dynamic-tool-description"]) {
		const { meta, content } = fixtureById(id);
		const manifest = parsePrompt(content, { sourceType: meta.sourceType });
		const schemas = manifest.blocks.filter((b) => b.kind === "tool_schema");
		assert.ok(schemas.length >= 1, `${id}: no tool_schema blocks`);
		for (const b of schemas) {
			assert.doesNotThrow(() => JSON.parse(b.text), `${id}: tool_schema block is not valid JSON`);
		}
	}
});

test("message roles are preserved for provider request shapes", () => {
	const { meta, content } = fixtureById("C01-openai-messages");
	const manifest = parsePrompt(content, { sourceType: meta.sourceType, provider: meta.provider });
	const roles = manifest.blocks.map((b) => b.role);
	assert.ok(roles.includes("system"), "system message lost");
	assert.ok(roles.includes("user"), "user message lost");
	assert.ok(roles.includes("assistant"), "assistant message lost");
	assert.equal(roles[roles.length - 1], "assistant", "message order not preserved");
});

test("input manifests are never mutated: analysis over a deep-frozen manifest", () => {
	const { meta, content } = fixtureById("D01-timestamp-prefix");
	const manifest = parsePrompt(content, { sourceType: meta.sourceType, provider: meta.provider });
	const frozen = deepFreeze(structuredClone(manifest));
	const snapshot = JSON.stringify(frozen);

	assert.doesNotThrow(() => {
		runRulesWithReport(frozen, allRules(), { provider: "cursor" });
		analyzeCacheStability(frozen);
		scoreManifest(frozen, [], {});
		computeFingerprint(frozen, {});
		redactManifestBlocks(frozen);
	});
	assert.equal(JSON.stringify(frozen), snapshot, "analyzers mutated a frozen manifest");
});

test("analyze() accepts the same content twice with identical fingerprints", () => {
	const { meta, content } = fixtureById("A06-stable-core-prompt");
	const a = analyze({ content, sourceType: meta.sourceType, provider: meta.provider });
	const b = analyze({ content, sourceType: meta.sourceType, provider: meta.provider });
	assert.equal(a.fingerprint.rootHash, b.fingerprint.rootHash);
	assert.deepEqual(a.scores, b.scores);
});

test("splitMarkdownBlocks keeps heading text and never emits empty blocks", () => {
	const md = "# A\n\nbody\n\n```js\nconst x = 1;\n```\n\n# B\n\nmore\n";
	const blocks = splitMarkdownBlocks(md);
	assert.equal(blocks.length, 3);
	assert.ok(blocks.every((b) => b.text.length > 0), "empty block emitted");
	assert.ok(blocks[1].text.startsWith("```js"), "fence block lost its opening marker");
});

test("serializeToMarkdown is defined and produces output for every fixture", () => {
	for (const { meta, content } of loadFixtures()) {
		const manifest = parsePrompt(content, { sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		const md = serializeToMarkdown(manifest);
		assert.equal(typeof md, "string");
		assert.ok(md.length > 0, `${meta.id}: empty markdown export`);
	}
});
