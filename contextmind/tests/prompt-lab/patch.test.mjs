/**
 * Patch model — instance-addressed, phase-ordered, fingerprint-guarded
 * (round-2: fixes §12.3 content-address ambiguity, spec §26).
 *
 * The regression this guards: block `id` is a content hash, so two
 * byte-identical blocks share ONE id and a DELETE addressed by id alone
 * removes BOTH copies. Every op here targets (blockId, occurrence).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrompt } from "../../lib/prompt-engine/parser.mjs";
import {
	OP,
	createPatch,
	applyPatch,
	reverseOps,
	blockListRoot,
	buildOccurrenceMap,
	locateOccurrence,
	refOf,
	patchOpsBetween,
	rebuildBlock,
} from "../../lib/prompt-engine/patch.mjs";

const DUP_MD =
	"# Rules\n\n- Deterministic ordering before every request.\n- Never reorder arrays that carry sequence meaning.\n\n" +
	"# Rules\n\n- Deterministic ordering before every request.\n- Never reorder arrays that carry sequence meaning.\n";

function manifestOf(md) {
	return parsePrompt(md, { sourceType: "markdown" });
}

test("content-address duplicates share one id but get distinct occurrences", () => {
	const m = manifestOf(DUP_MD);
	assert.equal(m.blocks.length, 2);
	assert.equal(m.blocks[0].id, m.blocks[1].id, "byte-identical blocks must share the content id");
	const occ = buildOccurrenceMap(m.blocks);
	assert.equal(occ.size, 2);
	assert.ok(occ.has(refOf(m.blocks[0].id, 0)));
	assert.ok(occ.has(refOf(m.blocks[0].id, 1)));
});

test("deleting the duplicate occurrence removes exactly one instance (round-1 bug: it removed BOTH)", () => {
	const m = manifestOf(DUP_MD);
	const id = m.blocks[0].id;
	const patch = createPatch({
		baseBlocks: m.blocks,
		operations: [{ type: OP.DELETE_DUPLICATE_BLOCK, blockId: id, occurrence: 1 }],
	});
	const { ok, manifest } = applyPatch(m, patch);
	assert.equal(ok, true);
	assert.equal(manifest.blocks.length, 1, "expected one copy to survive");
	assert.equal(manifest.blocks[0].text, m.blocks[0].text);
});

test("four duplicate copies: deleting occurrences 1..2 keeps 2 (occ 0 and occ 3)", () => {
	const m = manifestOf(DUP_MD + DUP_MD);
	assert.equal(m.blocks.length, 4);
	const id = m.blocks[0].id;
	const patch = createPatch({
		baseBlocks: m.blocks,
		operations: [
			{ type: OP.DELETE_DUPLICATE_BLOCK, blockId: id, occurrence: 1 },
			{ type: OP.DELETE_DUPLICATE_BLOCK, blockId: id, occurrence: 2 },
		],
	});
	const { manifest } = applyPatch(m, patch);
	assert.equal(manifest.blocks.length, 2);
});

test("applyPatch returns a NEW manifest and never mutates its input", () => {
	const m = manifestOf(DUP_MD);
	const snapshot = JSON.stringify(m);
	const patch = createPatch({
		baseBlocks: m.blocks,
		operations: [{ type: OP.DELETE_DUPLICATE_BLOCK, blockId: m.blocks[0].id, occurrence: 1 }],
	});
	const out = applyPatch(m, patch);
	assert.notEqual(out.manifest, m);
	assert.equal(JSON.stringify(m), snapshot, "input manifest was mutated");
});

test("a stale patch is refused (STALE_PATCH)", () => {
	const m = manifestOf("# Rules\n\n- keep me\n");
	const patch = createPatch({ baseFingerprint: "not-the-live-root", operations: [] });
	assert.throws(() => applyPatch(m, patch), /STALE_PATCH/);
	const soft = applyPatch(m, patch, { onStale: "return" });
	assert.equal(soft.ok, false);
	assert.equal(soft.reason, "STALE_PATCH");
});

test("NORMALIZE recomputes id/hash/tokenCount; the new id is content-addressed to the new text", () => {
	const m = manifestOf("# Rules\n\n-  behave deterministically  \n\n\n- never guess\n");
	const target = m.blocks[0];
	const normalized = "behave deterministically\n- never guess";
	const op = {
		type: OP.NORMALIZE_BLOCK,
		blockId: target.id,
		occurrence: 0,
		text: normalized,
		afterId: rebuildBlock(target, normalized).id,
	};
	const patch = createPatch({ baseBlocks: m.blocks, operations: [op] });
	const { manifest } = applyPatch(m, patch);
	const after = manifest.blocks[0];
	assert.equal(after.text, normalized);
	assert.notEqual(after.id, target.id, "content id must track the new text");
	assert.equal(after.hash, rebuildBlock(target, normalized).hash);
	assert.ok(after.tokenCount.count > 0);
	// re-normalizing is a no-op: canonical text is stable
	const again = parsePrompt(after.text, { sourceType: "markdown" });
	assert.equal(again.blocks[0].text, normalized);
});

test("REPLACE with insert=false swaps an instance; REPLACE with insert=true adds a missing one", () => {
	const m = manifestOf("# Rules\n\n- a\n\n# Instructions\n\n- b\n");
	const old = m.blocks[1];
	const replacement = { ...old, id: "replacement-id", text: "- b v2", hash: blockListRoot([{ hash: "- b v2" }]), tokenCount: { count: 2, method: "heuristic:chars/4", estimated: true } };
	const swap = createPatch({
		baseBlocks: m.blocks,
		operations: [{ type: OP.REPLACE_BLOCK, blockId: old.id, occurrence: 0, block: replacement, beforeBlock: old }],
	});
	const swapped = applyPatch(m, swap);
	assert.equal(swapped.manifest.blocks.length, 2);
	assert.equal(swapped.manifest.blocks[1].text, "- b v2");

	const insert = createPatch({
		baseBlocks: m.blocks,
		operations: [{ type: OP.REPLACE_BLOCK, blockId: "brand-new", occurrence: 0, block: replacement, insert: true, to: 1 }],
	});
	const added = applyPatch(m, insert);
	assert.equal(added.manifest.blocks.length, 3);
	assert.equal(added.manifest.blocks[1].text, "- b v2");
});

test("MOVE_BLOCK repositions an instance deterministically", () => {
	const m = manifestOf("# A\n\n- a\n\n# B\n\n- b\n\n# C\n\n- c\n");
	const ids = m.blocks.map((b) => b.id);
	const patch = createPatch({
		baseBlocks: m.blocks,
		operations: [{ type: OP.MOVE_BLOCK, blockId: ids[2], occurrence: 0, to: 0, from: 2 }],
	});
	const { manifest } = applyPatch(m, patch);
	assert.deepEqual(manifest.blocks.map((b) => b.id), [ids[2], ids[0], ids[1]]);
});

test("reverseOps: NORMALIZE is invertible; DELETE is not expressible and is counted", () => {
	const m = manifestOf("# Rules\n\n-  x  \n");
	const target = m.blocks[0];
	const normalized = "- x";
	const patch = createPatch({
		baseBlocks: m.blocks,
		operations: [
			{ type: OP.NORMALIZE_BLOCK, blockId: target.id, occurrence: 0, text: normalized, afterId: rebuildBlock(target, normalized).id, before: target.text },
			{ type: OP.DELETE_DUPLICATE_BLOCK, blockId: "nope", occurrence: 0 },
		],
	});
	const rev = reverseOps(patch);
	assert.ok(rev.ops.length >= 1, "NORMALIZE must have an inverse");
	assert.ok(rev.ops.every((o) => o.type === OP.NORMALIZE_BLOCK || o.type === OP.REPLACE_BLOCK));
	assert.equal(rev.omitted, 1, "DELETE has no INSERT primitive, so it cannot invert from ops alone");
	assert.equal(rev.fullyReversible, false);
});

test("patchOpsBetween produces an instance-correct delete for duplicate removal", () => {
	const before = manifestOf(DUP_MD);
	const after = manifestOf(DUP_MD.split("\n\n# Rules\n")[0]); // one copy
	const ops = patchOpsBetween(before.blocks, after.blocks);
	assert.ok(ops.some((o) => o.type === OP.DELETE_DUPLICATE_BLOCK && o.occurrence === 1), "expected the SECOND instance to be deleted");
	const patch = createPatch({ baseBlocks: before.blocks, operations: ops.filter((o) => o.type === OP.DELETE_DUPLICATE_BLOCK) });
	const { manifest } = applyPatch(before, patch);
	assert.equal(manifest.blocks.length, 1);
	assert.equal(manifest.blocks[0].text, after.blocks[0].text);
});

test("locateOccurrence resolves the nth block with an id in the live array", () => {
	const m = manifestOf(DUP_MD);
	assert.equal(locateOccurrence(m.blocks, m.blocks[0].id, 0), 0);
	assert.equal(locateOccurrence(m.blocks, m.blocks[0].id, 1), 1);
	assert.equal(locateOccurrence(m.blocks, m.blocks[0].id, 2), -1);
	assert.equal(locateOccurrence(m.blocks, "absent", 0), -1);
});
