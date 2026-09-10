import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PromptLabStore, docIdOf } from "../../lib/prompt-lab/store.mjs";
import { parsePrompt } from "../../lib/prompt-engine/parser.mjs";
import { sha256 } from "../../lib/prompt-engine/manifest.mjs";
import { fixtureById } from "./_helpers.mjs";

const tmp = mkdtempSync(join(tmpdir(), "pl-store-"));
const stores = [];
after(() => {
	for (const s of stores) s.close();
	rmSync(tmp, { recursive: true, force: true });
});

function freshStore(name) {
	const s = PromptLabStore.open(join(tmp, `${name}.db`));
	stores.push(s);
	return s;
}

const A10 = fixtureById("A10-duplicate-rule-blocks");
const A10_MD = A10.content;
const A10_MANIFEST = parsePrompt(A10_MD, { sourceType: "markdown" });
const A10_BLOCKS = A10_MANIFEST.blocks.length;

const SAMPLE_MD = "# Rules\n\n- Always reply in Chinese.\n- Never mutate the input manifest.\n\n# Project Context\n\nStatic repo map.\n";

test("store: schema ensure + zero telemetry + provider registry seeded", () => {
	const s = freshStore("schema");
	assert.equal(s.ready, true);
	const counters = s.getCounters();
	for (const k of Object.keys(counters)) assert.equal(counters[k], 0, `${k} starts at 0`);
	const providers = s.listProviderCapabilities();
	const ids = providers.map((p) => p.provider);
	for (const id of ["openai", "anthropic", "cursor", "codex", "qwen", "generic"]) assert.ok(ids.includes(id), `${id} seeded`);
	const openai = providers.find((p) => p.provider === "openai");
	assert.equal(openai.capabilities.exactPrefixCache, true);
	assert.equal(openai.capabilities.tokenizerId, "heuristic:chars/4");
});

test("store: document identity is content-addressed (same bytes → one doc)", () => {
	const s = freshStore("docid");
	const a = s.ensureDocument(SAMPLE_MD, { title: "one", sourceType: "markdown" });
	const b = s.ensureDocument(SAMPLE_MD, { title: "two", sourceType: "markdown" });
	assert.equal(a.documentId, b.documentId);
	assert.equal(b.created, false, "second insert is an update, not a create");
	assert.equal(a.documentId, docIdOf(sha256(SAMPLE_MD)));
	const different = s.ensureDocument(SAMPLE_MD + "\n- extra\n", {});
	assert.notEqual(different.documentId, a.documentId);
});

test("store: saveVersion persists blocks/findings/fingerprint and history lists it", () => {
	const s = freshStore("versions");
	const v = s.saveVersion({
		content: SAMPLE_MD,
		manifest: parsePrompt(SAMPLE_MD, { sourceType: "markdown" }),
		scores: { quality: 70, cacheStability: 80, risk: 10 },
		tokensAfter: 40,
		kind: "analyze",
		sourceType: "markdown",
		fingerprint: { root: "fp-root" },
		stablePrefixRatio: 0.9,
	});
	s.saveFindings(v.id, [
		{ ruleId: "Q01", severity: "LOW", category: "QUALITY", blockIds: [], title: "t", explanation: "e" },
	]);
	s.saveFingerprint(v.id, { root: "fp-root", segments: { system: "s" } });

	assert.equal(v.kind, "analyze");
	assert.equal(v.version_no, 1);
	const list = s.historyList({});
	assert.equal(list.total, 1);
	assert.equal(list.versions[0].uri, `prompt://${v.document_id}/${v.version_no}`);
	assert.equal(list.versions[0].scores.quality, 70);

	const detail = s.versionDetail(v.id);
	assert.ok(detail.blocks.length >= 2);
	assert.equal(detail.findings.length, 1);
	assert.equal(detail.fingerprints.length, 1);
	assert.equal(detail.fingerprints[0].root, "fp-root");

	const manifest = s.manifestOf(v.id);
	assert.equal(manifest.blocks.length, detail.blocks.length);
	// version number sequencing per document: identical bytes → same doc, next no
	const v2 = s.saveVersion({ content: SAMPLE_MD, manifest: parsePrompt(SAMPLE_MD, { sourceType: "markdown" }), kind: "analyze" });
	assert.equal(v2.version_no, 2);
	assert.equal(v2.document_id, v.document_id, "identical source bytes keep one document");
});

test("store: acceptPatch applies single op, writes child version + applied patch row", () => {
	const s = freshStore("patch");
	const v = s.saveVersion({ content: A10_MD, manifest: A10_MANIFEST, kind: "analyze", sourceType: "markdown" });
	assert.equal(A10_BLOCKS >= 2, true, "fixture duplicates at least one rule instance");

	const m = A10_MANIFEST.blocks;
	// find first duplicated id and target occurrence 1 (second instance)
	const counts = new Map();
	let dupId = null;
	for (const b of m) {
		const n = (counts.get(b.id) ?? 0) + 1;
		counts.set(b.id, n);
		if (n === 2) { dupId = b.id; break; }
	}
	assert.ok(dupId, "duplicated id found");
	const before = s.manifestOf(v.id).blocks.length;
	const r = s.acceptPatch(v.id, [{ type: "DELETE_DUPLICATE_BLOCK", blockId: dupId, occurrence: 1 }]);
	assert.equal(r.ok, true);
	assert.equal(s.versionRow(r.childVersionId).kind, "patch_apply");
	assert.equal(s.manifestOf(r.childVersionId).blocks.length, before - 1);
	const patches = s.patchesOf(v.id);
	assert.equal(patches.some((p) => p.applied === 1 && p.child_version_id === r.childVersionId), true);
	assert.equal(s.getCounters().patch_apply_count, 1);
});

test("store: STALE / bad ops are refused and counted as rejected", () => {
	const s = freshStore("reject");
	const v = s.saveVersion({ content: SAMPLE_MD, manifest: parsePrompt(SAMPLE_MD, { sourceType: "markdown" }), kind: "analyze" });
	const r = s.acceptPatch(v.id, [{ type: "DELETE_DUPLICATE_BLOCK", blockId: "nope-not-here", occurrence: 0 }]);
	assert.equal(r.ok, false);
	assert.equal(r.reason, "OPS_SKIPPED", "target instance absent → op skipped, nothing applied");
	assert.equal(s.getCounters().patch_rejected_count, 1);
	assert.equal(s.historyList({}).total, 1, "no child version on failure");
});

test("store: undo restores the parent snapshot as a new restore version", () => {
	const s = freshStore("undo");
	const v = s.saveVersion({ content: SAMPLE_MD, manifest: parsePrompt(SAMPLE_MD, { sourceType: "markdown" }), kind: "analyze" });
	const manifest = s.manifestOf(v.id);
	const target = manifest.blocks[0];
	const replaced = { ...target, id: "newid-abcdef", text: target.text + " ", hash: "h2" };
	const rep = s.acceptPatch(v.id, [{ type: "REPLACE_BLOCK", blockId: target.id, occurrence: 0, block: replaced, beforeBlock: target }]);
	assert.equal(rep.ok, true);
	const undo = s.undoToParent(rep.childVersionId);
	assert.equal(undo.ok, true);
	const restored = s.manifestOf(undo.restoredVersionId);
	assert.equal(restored.blocks.length, manifest.blocks.length);
	assert.equal(s.versionRow(undo.restoredVersionId).kind, "restore");
	assert.equal(s.getCounters().patch_reverse_count, 1);
	// version chain: analyze(1) → patch_apply(2) → restore(3)
	assert.equal(s.historyList({}).total, 3);
});
