/**
 * Fingerprint determinism and sensitivity (spec §23, §52).
 *
 * A fingerprint is only useful if BOTH hold:
 *   determinism — identical input always yields an identical fingerprint;
 *   sensitivity — the changes that matter (dynamic tail, ephemeral breaker,
 *                 tool reorder) actually move it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrompt } from "../../lib/prompt-engine/parser.mjs";
import { computeFingerprint, segmentMap, diffSnapshots } from "../../lib/prompt-engine/fingerprint.mjs";
import { analyzeCacheStability } from "../../lib/prompt-engine/cache-analyzer.mjs";
import { fingerprint as fingerprintOf } from "../../lib/prompt-engine/index.mjs";
import { loadFixtures, fixtureById } from "./_helpers.mjs";

const SEGMENTS = ["system", "rules", "skills", "tools", "project", "dynamic", "user"];

function fp(content, opts = {}) {
	const m = typeof content === "string" ? parsePrompt(content, opts) : content;
	const cache = analyzeCacheStability(m);
	return { manifest: m, fp: computeFingerprint(m, { stablePrefixTokens: cache.stablePrefixTokens, firstDynamicBlock: cache.firstDynamicBlock }) };
}

test("fingerprint is deterministic across repeated runs", () => {
	for (const { meta, content } of loadFixtures()) {
		const a = fp(content, { sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		const b = fp(content, { sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		assert.equal(a.fp.rootHash, b.fp.rootHash, `${meta.id}: root hash not deterministic`);
		assert.deepEqual(a.fp.segments, b.fp.segments, `${meta.id}: segments not deterministic`);
	}
});

test("fingerprint carries schema version and all seven segment hashes", () => {
	const { fp: f } = fp("# Rules\n\n- be deterministic\n");
	assert.equal(f.schemaVersion, "1.0");
	for (const key of SEGMENTS) {
		assert.equal(typeof f.segments[key], "string", `missing segment hash: ${key}`);
		assert.equal(f.segments[key].length, 64, `segment ${key} is not a sha256 hex`);
	}
});

test("changing only the user request leaves the stable segments untouched", () => {
	const base = "# Rules\n\n- be deterministic\n\n# User Request\n\nRefactor the parser.\n";
	const other = "# Rules\n\n- be deterministic\n\n# User Request\n\nRewrite the serializer instead.\n";
	const a = fp(base, { sourceType: "markdown" });
	const b = fp(other, { sourceType: "markdown" });
	for (const key of ["system", "rules", "tools", "project"]) {
		assert.equal(a.fp.segments[key], b.fp.segments[key], `stable segment ${key} moved on a user-only edit`);
	}
	assert.notEqual(a.fp.segments.user, b.fp.segments.user, "user segment did not move on a user edit");
});

test("changing only a timestamp is located as the first dynamic block", () => {
	const base = "# Rules\n\n- be deterministic\n\n# Runtime\n\ncurrent_time: 2026-09-09T10:32:20Z\n";
	const a = fp(base, { sourceType: "markdown" });
	const b = fp(base.replace("10:32:20", "11:45:03"), { sourceType: "markdown" });
	assert.notEqual(a.fp.rootHash, b.fp.rootHash, "timestamp edit invisible to the fingerprint");
	assert.ok(b.fp.firstDynamicBlock, "no firstDynamicBlock located for an ephemeral breaker");
	const dynamic = b.manifest.blocks.find((x) => x.id === b.fp.firstDynamicBlock);
	assert.ok(dynamic, "firstDynamicBlock does not resolve to a block");
	assert.equal(dynamic.stability, "EPHEMERAL", "timestamp block should be classified EPHEMERAL, not STATIC");
});

test("tool reorder changes the tools segment hash (spec §52)", () => {
	const a = fixtureById("B01-mcp-tools-list");
	const b = fixtureById("B03-tools-order-swapped");
	const fa = fp(a.content, { sourceType: a.meta.sourceType });
	const fb = fp(b.content, { sourceType: b.meta.sourceType });
	assert.notEqual(fa.fp.segments.tools, fb.fp.segments.tools, "tool reorder was invisible to the fingerprint");
	assert.equal(fa.fp.segments.system, fb.fp.segments.system, "tool reorder must not move the system segment");
});

test("diffSnapshots reports a reorder that plain text equality would miss", () => {
	const a = fixtureById("B01-mcp-tools-list");
	const b = fixtureById("B03-tools-order-swapped");
	const ma = parsePrompt(a.content, { sourceType: a.meta.sourceType });
	const mb = parsePrompt(b.content, { sourceType: b.meta.sourceType });
	const d = diffSnapshots(ma, mb);
	assert.ok(d.cacheDiff.firstDivergentIndex >= 0, "reorder not detected as a prefix divergence");
	assert.ok(d.cacheDiff.segmentsChanged.includes("tools"), "tools segment not reported as changed");
});

test("segmentMap maps every block id to one of the seven segments", () => {
	for (const { meta, content } of loadFixtures()) {
		const m = parsePrompt(content, { sourceType: meta.sourceType ?? undefined, provider: meta.provider });
		const map = segmentMap(m);
		// Block ids are content-addressed (§9.3), so byte-identical blocks share
		// one id by design — compare against the distinct id count.
		const distinct = new Set(m.blocks.map((b) => b.id)).size;
		assert.equal(Object.keys(map).length, distinct, `${meta.id}: segmentMap incomplete`);
		for (const v of Object.values(map)) assert.ok(SEGMENTS.includes(v), `unknown segment ${v}`);
	}
});

test("fingerprint() entry point agrees with computeFingerprint on the same input", () => {
	const { meta, content } = fixtureById("A06-stable-core-prompt");
	const a = fingerprintOf(content, { sourceType: meta.sourceType, provider: meta.provider });
	const b = fp(content, { sourceType: meta.sourceType, provider: meta.provider });
	assert.equal(a.rootHash, b.fp.rootHash);
});
