/**
 * Prompt Patch — reversible, fingerprint-guarded, INSTANCE-ADDRESSED patch
 * model (Prompt Lab spec §26 / §P5 / §P6).
 *
 * Why instance addressing (round-2 decision, see ADR-0011):
 * block `id` is a content hash (spec §9.3), so two byte-identical blocks —
 * e.g. fixture A10's duplicated rule section — share ONE id. Any patch that
 * locates a target by `id` alone therefore cannot tell "duplicate #1" from
 * "duplicate #2", and a DELETE of "the duplicate" would delete BOTH copies.
 *
 * Every operation therefore targets a block *instance*:
 *
 *     { blockId, occurrence }      occurrence = 0-based rank among blocks
 *                                  sharing that id in the BASE manifest
 *
 * The occurrence is deterministic for a given base manifest, so patches stay
 * portable across sessions as long as the base fingerprint matches (STALE
 * guard). This fixes §12.3 without changing the content-addressed IR.
 *
 * Application is phase-ordered so occurrence numbers are always resolved
 * against the base snapshot they were computed against:
 *   1. removals   (DELETE_DUPLICATE_BLOCK)      — resolved on the base array
 *   2. content    (NORMALIZE_BLOCK / REPLACE_BLOCK) — base-resolved, remapped
 *   3. layout     (MOVE_BLOCK / MERGE_BLOCKS)   — applied to the live array
 *
 * spec §26: never overwrite a source file. `applyPatch` returns a NEW
 * manifest; it refuses (STALE_PATCH) when the live fingerprint does not
 * match the base the patch was computed on.
 */

import { sha256, blockIdOf } from "./manifest.mjs";
import { countTokens } from "../tokens.mjs";

export const OP = Object.freeze({
	DELETE_DUPLICATE_BLOCK: "DELETE_DUPLICATE_BLOCK",
	MOVE_BLOCK: "MOVE_BLOCK",
	REPLACE_BLOCK: "REPLACE_BLOCK",
	MERGE_BLOCKS: "MERGE_BLOCKS",
	NORMALIZE_BLOCK: "NORMALIZE_BLOCK",
	EXTRACT_DYNAMIC_BLOCK: "EXTRACT_DYNAMIC_BLOCK",
	EXTRACT_TOOL_GUIDANCE: "EXTRACT_TOOL_GUIDANCE",
});

export const PATCH_RISK = Object.freeze(["SAFE", "REVIEW", "EXPERIMENTAL"]);

/** Canonical instance reference string `${blockId}#${occurrence}`. */
export function refOf(blockId, occurrence = 0) {
	return `${blockId}#${occurrence}`;
}

/**
 * Map instance ref → absolute index into `blocks` for the FIRST pass of an
 * application. `blocks` is the base snapshot the patch was computed against.
 */
export function buildOccurrenceMap(blocks) {
	const counts = new Map();
	const map = new Map();
	for (let i = 0; i < (blocks ?? []).length; i += 1) {
		const b = blocks[i];
		const occ = counts.get(b.id) ?? 0;
		counts.set(b.id, occ + 1);
		map.set(refOf(b.id, occ), i);
	}
	return map;
}

/**
 * Locate the (occurrence)-th block with `blockId` in the CURRENT array.
 * Used only where ids are guaranteed unique in the live list (layout phase);
 * ambiguous targets must be resolved against the base via buildOccurrenceMap.
 */
export function locateOccurrence(blocks, blockId, occurrence = 0) {
	let seen = -1;
	for (let i = 0; i < blocks.length; i += 1) {
		if (blocks[i].id !== blockId) continue;
		seen += 1;
		if (seen === occurrence) return i;
	}
	return -1;
}

/**
 * Rebuild a block whose text changed (NORMALIZE / REPLACE): content-addressed
 * id, hash and token count are all re-derived from the NEW text. Never mutates
 * the input block.
 */
export function rebuildBlock(block, text) {
	const next = String(text ?? "");
	return {
		...block,
		id: blockIdOf({ kind: block.kind, text: next, provenance: block.provenance }),
		text: next,
		hash: sha256(next),
		tokenCount: { count: countTokens(next), method: "heuristic:chars/4", estimated: true },
	};
}

/** Root hash of a block list (the value patches are fingerprinted against). */
export function blockListRoot(blocks) {
	return sha256(JSON.stringify((blocks ?? []).map((b) => b.hash)));
}

/**
 * Build a patch header. `baseFingerprint` must be the blockListRoot of the
 * manifest the operations were computed against (defaults to deriving it from
 * `baseBlocks` when provided).
 */
export function createPatch({ baseFingerprint, baseBlocks = null, operations = [], risk = "SAFE", evidence = {}, metadata = {} }) {
	const base = baseFingerprint ?? (baseBlocks ? blockListRoot(baseBlocks) : null);
	return {
		patchId: sha256(`${base ?? ""}\u0000${JSON.stringify(operations)}`, 12),
		baseFingerprint: base,
		operations,
		risk,
		reversible: true,
		evidence,
		metadata,
		createdAt: Date.now(),
	};
}

/** Effective risk of a patch = the highest-risk op it contains. */
export function patchRiskOf(operations) {
	const order = { SAFE: 0, REVIEW: 1, EXPERIMENTAL: 2 };
	let risk = "SAFE";
	for (const op of operations ?? []) {
		if (order[op.risk] > order[risk]) risk = op.risk;
	}
	return risk;
}

/**
 * Apply a patch to a manifest — returns a NEW manifest; the input is never
 * mutated. `onStale`: "throw" (default) or return { ok:false, reason }.
 *
 * Semantics:
 *  - DELETE_DUPLICATE_BLOCK  { blockId, occurrence }  removes that instance.
 *  - NORMALIZE_BLOCK         { blockId, occurrence, text } rewrites that
 *    instance's text (id/hash/tokenCount recomputed). Target must exist.
 *  - REPLACE_BLOCK           { blockId, occurrence, block, to?, insert? }
 *    swaps the instance for `block`. When `insert` is set and the target does
 *    not exist, the block is inserted at `to` (default: end).
 *  - MOVE_BLOCK              { blockId, occurrence, to } repositions the
 *    instance inside the live array.
 *  - MERGE_BLOCKS            { blockIds:[{blockId,occurrence}], block?,
 *    to? } removes the listed instances and places the merged block at the
 *    position of the first removed instance (or `to`).
 *  - EXTRACT_* are informational (applied by REORDER paths only).
 */
export function applyPatch(manifest, patch, { onStale = "throw" } = {}) {
	const base = [...(manifest?.blocks ?? [])];
	const liveRoot = blockListRoot(base);
	if (patch?.baseFingerprint && liveRoot !== patch.baseFingerprint) {
		const err = new Error(
			`STALE_PATCH: base fingerprint ${patch.baseFingerprint} does not match live root ${liveRoot}. ` +
				`Refuse to apply to avoid overwriting a newer snapshot.`,
		);
		if (onStale === "throw") throw err;
		return { ok: false, reason: "STALE_PATCH", error: err };
	}

	const baseRefIndex = buildOccurrenceMap(base);
	const ops = patch?.operations ?? [];
	const applied = [];
	const skipped = [];

	// ── Phase 1 — removals (resolved against the BASE array) ──────────────
	const removedBase = new Set();
	for (const [k, op] of ops.entries()) {
		if (op.type !== OP.DELETE_DUPLICATE_BLOCK) continue;
		const idx = baseRefIndex.get(refOf(op.blockId, op.occurrence ?? 0));
		if (idx === undefined) {
			skipped.push({ index: k, op: { ...op }, reason: "target instance not found in base" });
			continue;
		}
		removedBase.add(idx);
		applied.push(k);
	}

	// ── Phase 2 — content (base-resolved, remapped onto the survivors) ─────
	const removedCount = removedBase.size;
	const working = base.filter((_, i) => !removedBase.has(i));
	// base index → working index
	const remap = new Map();
	{
		let w = 0;
		for (let i = 0; i < base.length; i += 1) {
			if (!removedBase.has(i)) remap.set(i, w++);
		}
	}

	for (const [k, op] of ops.entries()) {
		if (op.type !== OP.NORMALIZE_BLOCK && op.type !== OP.REPLACE_BLOCK) continue;
		const ref = refOf(op.blockId, op.occurrence ?? 0);
		if (op.type === OP.REPLACE_BLOCK && op.insert && !baseRefIndex.has(ref)) {
			const pos = Math.max(0, Math.min(working.length, op.to ?? working.length));
			working.splice(pos, 0, op.block);
			applied.push(k);
			continue;
		}
		const baseIdx = baseRefIndex.get(ref);
		if (baseIdx === undefined) {
			skipped.push({ index: k, op: { ...op }, reason: "target instance not found in base" });
			continue;
		}
		if (removedBase.has(baseIdx)) {
			return { ok: false, reason: "OP_CONFLICT", message: `op #${k} (${op.type}) targets an instance removed earlier in the same patch` };
		}
		const w = remap.get(baseIdx);
		if (op.type === OP.NORMALIZE_BLOCK) {
			working[w] = rebuildBlock(working[w], op.text);
		} else {
			working[w] = op.block;
		}
		applied.push(k);
	}

	// ── Phase 3 — layout (live array, op order) ────────────────────────────
	for (const [k, op] of ops.entries()) {
		if (op.type !== OP.MOVE_BLOCK && op.type !== OP.MERGE_BLOCKS) continue;
		if (op.type === OP.MOVE_BLOCK) {
			const idx = locateOccurrence(working, op.blockId, op.occurrence ?? 0);
			if (idx < 0) {
				skipped.push({ index: k, op: { ...op }, reason: "target instance not found in live array" });
				continue;
			}
			const [b] = working.splice(idx, 1);
			const to = Math.max(0, Math.min(working.length, op.to ?? working.length));
			working.splice(to, 0, b);
			applied.push(k);
			continue;
		}
		// MERGE_BLOCKS
		const targets = (op.blockIds ?? []).map((r) => locateOccurrence(working, r.blockId, r.occurrence ?? 0));
		if (targets.some((t) => t < 0)) {
			skipped.push({ index: k, op: { ...op }, reason: "one or more merge targets not found in live array" });
			continue;
		}
		const first = Math.min(...targets);
		const merged =
			op.block ??
			((() => {
				const members = targets
					.slice()
					.sort((a, b) => a - b)
					.map((t) => working[t]);
				const text = members.map((b) => b.text).join("\n");
				return {
					...members[0],
					id: sha256(`merged-${members.map((b) => b.id).join(",")}`, 16),
					text,
					hash: sha256(text),
					tokenCount: { count: members.reduce((a, b) => a + (b.tokenCount?.count ?? 0), 0), method: "heuristic:chars/4", estimated: true },
				};
			})());
		const toRemove = new Set(targets);
		const rest = working.filter((_, i) => !toRemove.has(i));
		const insertAt = Math.max(0, Math.min(rest.length, op.to ?? first));
		rest.splice(insertAt, 0, merged);
		working.splice(0, working.length, ...rest);
		applied.push(k);
	}

	return {
		ok: true,
		manifest: { ...manifest, blocks: working, hash: blockListRoot(working) },
		removedCount,
		applied: applied.length,
		skipped,
	};
}

/**
 * Derive the expressible inverse operations of a patch against the *patched*
 * manifest. Ops whose inverse is not representable in the §26 vocabulary
 * (DELETE needs an INSERT primitive) are omitted and counted, so consumers
 * can tell "fully reversible from ops" from "restore via original snapshot"
 * (P6 always keeps the original manifest).
 */
export function reverseOps(patch) {
	const inverses = [];
	let omitted = 0;
	for (const op of patch?.operations ?? []) {
		switch (op.type) {
			case OP.NORMALIZE_BLOCK: {
				// After application the block carries a NEW content id; invert
				// by normalizing that id back to the original text.
				const afterId = op.afterId ?? op.blockId;
				inverses.push({ type: OP.NORMALIZE_BLOCK, blockId: afterId, occurrence: 0, text: op.before ?? "", why: "reverse NORMALIZE" });
				break;
			}
			case OP.REPLACE_BLOCK: {
				if (op.beforeBlock) {
					inverses.push({ type: OP.REPLACE_BLOCK, blockId: op.afterId ?? op.blockId, occurrence: 0, block: op.beforeBlock, why: "reverse REPLACE" });
				} else omitted += 1;
				break;
			}
			case OP.MOVE_BLOCK: {
				inverses.push({ type: OP.MOVE_BLOCK, blockId: op.blockId, occurrence: op.occurrence ?? 0, to: op.from ?? 0, why: "reverse MOVE" });
				break;
			}
			default:
				omitted += 1;
		}
	}
	return { ops: inverses, omitted, fullyReversible: omitted === 0 };
}

/**
 * Canonical diff ops that turn `beforeBlocks` into `afterBlocks`. Instances
 * are matched by (id, occurrence), so content-address duplicates (same id,
 * multiple instances) diff correctly. Used by the diff / export surface for
 * reversible patch generation.
 */
export function patchOpsBetween(beforeBlocks, afterBlocks) {
	const before = (beforeBlocks ?? []).map((b) => ({ ...b }));
	const after = (afterBlocks ?? []).map((b) => ({ ...b }));
	const ops = [];

	const beforeInst = instancesOf(before);
	const afterInst = instancesOf(after);
	const beforeRefs = new Map(beforeInst.map((x, i) => [refOf(x.id, x.occ), i]));
	const afterRefs = new Set(afterInst.map((a) => refOf(a.id, a.occ)));

	// 1) removals — every before instance whose ref is absent from after.
	// (Same id ⇒ same content hash by construction of blockIdOf, so ref
	// presence is a complete identity test.)
	for (const b of beforeInst) {
		if (!afterRefs.has(refOf(b.id, b.occ))) {
			ops.push({ type: OP.DELETE_DUPLICATE_BLOCK, blockId: b.id, occurrence: b.occ });
		}
	}

	// 2) additions / content changes
	for (const [i, a] of afterInst.entries()) {
		const ref = refOf(a.id, a.occ);
		const bIdx = beforeRefs.get(ref);
		if (bIdx === undefined) {
			ops.push({ type: OP.REPLACE_BLOCK, blockId: a.id, occurrence: a.occ, block: after[i], insert: true, to: i });
		} else if (before[bIdx].hash !== a.hash) {
			ops.push({ type: OP.REPLACE_BLOCK, blockId: a.id, occurrence: a.occ, block: after[i], beforeBlock: before[bIdx] });
		}
	}

	// 3) order drift — replay survivors toward the after-order
	const survivors = beforeInst.map((b, i) => i).filter((i) => afterRefs.has(refOf(beforeInst[i].id, beforeInst[i].occ)));
	const want = [];
	for (let i = 0; i < afterInst.length; i += 1) {
		const bIdx = beforeRefs.get(refOf(afterInst[i].id, afterInst[i].occ));
		if (bIdx !== undefined) want.push(bIdx);
	}
	const temp = survivors.slice();
	for (let t = 0; t < want.length; t += 1) {
		const cur = temp.indexOf(want[t]);
		if (cur === t) continue;
		const b = beforeInst[want[t]];
		ops.push({ type: OP.MOVE_BLOCK, blockId: b.id, occurrence: b.occ, to: t, from: cur });
		temp.splice(cur, 1);
		temp.splice(t, 0, want[t]);
	}
	return ops;
}

/** [{ id, occ, index }] — per-instance view of a block array. */
function instancesOf(blocks) {
	const counts = new Map();
	const out = [];
	for (let i = 0; i < blocks.length; i += 1) {
		const id = blocks[i].id;
		const occ = counts.get(id) ?? 0;
		counts.set(id, occ + 1);
		out.push({ id, occ, index: i });
	}
	return out;
}
