/**
 * Prompt Fingerprint — segment hashes, root fingerprint, snapshot diff.
 *
 * Prompt Lab spec §23 defines the fingerprint structure; spec §24 defines a
 * four-layer diff (text / semantic block / token / cache-prefix) because a
 * plain text diff misses reorders that break cache stability. Both live here
 * so Analyze can return a fingerprint and Compare can diff two snapshots.
 */

import { sha256 } from "./manifest.mjs";
import { canonicalizeBlockText, canonicalStringify } from "./canonicalizer.mjs";

const SEGMENT_KEYS = Object.freeze([
	"system",
	"rules",
	"skills",
	"tools",
	"project",
	"dynamic",
	"user",
]);

export function segmentOfBlock(block) {
	switch (block.kind) {
		case "tool_schema":
			return "tools";
		case "project_contract":
		case "repo_map":
		case "wiki":
			return "project";
		case "rule":
			return "rules";
		case "example":
			return "skills";
		case "history":
		case "tool_result":
		case "brain_memory":
		case "rag":
		case "runtime_metadata":
			return "dynamic";
		case "user_request":
			return "user";
		default:
			return block.role === "system" || block.role === "developer" ? "system" : "dynamic";
	}
}

/** Full sha256 hex of the canonical text of one block. */
export function blockFingerprint(block) {
	return sha256(canonicalizeBlockText(block.text));
}

/**
 * Segment hash: canonical JSON of the segment's block texts IN ORIGINAL ORDER.
 *
 * Order is semantic (spec §9.1: arrays keep order when ordering is meaningful;
 * block order is the prompt). This used to sort blocks by id, which made a
 * tool reorder invisible to the fingerprint — exactly the regression §52
 * requires us to catch ("只换 tool order => tools hash 改变").
 *
 * An empty segment hashes to sha256("").
 */
export function segmentHash(blocks) {
	const payload = (blocks ?? []).map((b) => ({ id: b.id, text: canonicalizeBlockText(b.text) }));
	return sha256(JSON.stringify(payload));
}

function groupBySegment(blocks) {
	const groups = { system: [], rules: [], skills: [], tools: [], project: [], dynamic: [], user: [] };
	for (const b of blocks ?? []) groups[segmentOfBlock(b)].push(b);
	return groups;
}

/**
 * Compute the fingerprint of a manifest:
 *   root_hash + per-segment hashes + stable prefix tokens + first dynamic.
 *
 * `stablePrefixTokens` is optional and supplied by the cache analyzer so the
 * fingerprint carries the caching story, not just content (spec §23).
 */
export function computeFingerprint(manifest, { stablePrefixTokens = null, firstDynamicBlock = null } = {}) {
	const blocks = manifest?.blocks ?? [];
	const groups = groupBySegment(blocks);
	const segments = {};
	for (const key of SEGMENT_KEYS) segments[key] = segmentHash(groups[key]);

	const root = sha256(
		canonicalStringify({
			provider: manifest?.provider ?? null,
			model: manifest?.model ?? null,
			segments,
		}),
	);

	let firstDynamic = firstDynamicBlock;
	if (!firstDynamic) {
		const found = blocks.find((b) => b.stability === "DYNAMIC" || b.stability === "EPHEMERAL");
		firstDynamic = found?.id ?? null;
	}

	return {
		schemaVersion: "1.0",
		promptId: manifest?.promptId ?? null,
		provider: manifest?.provider ?? null,
		modelFamily: manifest?.model || null,
		rootHash: root,
		segments,
		stablePrefixTokens,
		firstDynamicBlock: firstDynamic,
	};
}

/** Quick equality: same root hash means identical canonical content/provider. */
export function fingerprintsEqual(a, b) {
	return a?.rootHash === b?.rootHash;
}

/**
 * Map block id → segment name for a snapshot, used to spot a block that
 * jumped segments between versions.
 */
export function segmentMap(manifest) {
	const map = {};
	for (const b of manifest?.blocks ?? []) map[b.id] = segmentOfBlock(b);
	return map;
}

// ─── snapshot diff (spec §24) ───

/**
 * Diff two manifests across four layers:
 *  - text:   raw full-text equality
 *  - blocks: added / removed / changed block ids
 *  - tokens: before/after totals
 *  - cache:  segment fingerprint changes that hurt a stable prefix
 *
 * `a` / `b` are manifests (or already-computed fingerprints).
 */
export function diffSnapshots(a, b, { aTokens = null, bTokens = null } = {}) {
	const blocksA = a?.blocks ?? [];
	const blocksB = b?.blocks ?? [];

	const textA = blocksA.map((x) => x.text).join("\n");
	const textB = blocksB.map((x) => x.text).join("\n");
	const textSame = textA === textB;

	const mapB = new Map(blocksB.map((x) => [x.id, x]));
	const added = [];
	const removed = [];
	const changed = [];
	for (const block of blocksA) {
		if (!mapB.has(block.id)) {
			removed.push({ id: block.id, kind: block.kind, segment: segmentOfBlock(block) });
		} else if (mapB.get(block.id).text !== block.text) {
			changed.push({ id: block.id, kind: block.kind, segment: segmentOfBlock(block) });
		}
	}
	for (const block of blocksB) {
		if (!blocksA.some((x) => x.id === block.id)) {
			added.push({ id: block.id, kind: block.kind, segment: segmentOfBlock(block) });
		}
	}

	const fpA = (a?.rootHash ? a : computeFingerprint(a)) ?? computeFingerprint({ blocks: blocksA });
	const fpB = (b?.rootHash ? b : computeFingerprint(b)) ?? computeFingerprint({ blocks: blocksB });

	const cacheSegmentsChanged = [];
	for (const key of SEGMENT_KEYS) {
		if ((fpA.segments?.[key] ?? "") !== (fpB.segments?.[key] ?? "")) {
			cacheSegmentsChanged.push(key);
		}
	}

	// Cache-prefix regression: first segment that differs in order.
	const textMapA = blocksA.map((x) => x.hash);
	const textMapB = blocksB.map((x) => x.hash);
	let firstDivergentIndex = -1;
	for (let i = 0; i < Math.min(textMapA.length, textMapB.length); i += 1) {
		if (textMapA[i] !== textMapB[i]) {
			firstDivergentIndex = i;
			break;
		}
	}
	if (firstDivergentIndex < 0 && textMapA.length !== textMapB.length) {
		firstDivergentIndex = Math.min(textMapA.length, textMapB.length);
	}

	const beforeTokens = aTokens ?? blocksA.reduce((acc, b) => acc + (b.tokenCount?.count ?? 0), 0);
	const afterTokens = bTokens ?? blocksB.reduce((acc, b) => acc + (b.tokenCount?.count ?? 0), 0);

	return {
		same: textSame && added.length === 0 && removed.length === 0 && changed.length === 0,
		textDiff: { same: textSame, textA: textA.length, textB: textB.length },
		blockDiff: { added, removed, changed, firstDivergentIndex },
		tokenDiff: { beforeTokens, afterTokens, delta: afterTokens - beforeTokens },
		cacheDiff: { segmentsChanged: cacheSegmentsChanged, firstDivergentIndex },
	};
}

/** Whether a snapshot pair is cache-regression safe (no early segment drift). */
export function isCacheRegressionSafe(diff) {
	if (!diff?.cacheDiff) return true;
	if (diff.cacheDiff.segmentsChanged?.length === 0) return true;
	// A change in the "user" segment is expected and benign for prefix cache;
	// anything before it threatens the stable prefix.
	const changed = diff.cacheDiff.segmentsChanged;
	const orderOf = (s) => (s === "system" ? 0 : s === "rules" ? 1 : s === "skills" ? 2 : s === "tools" ? 3 : s === "project" ? 4 : s === "dynamic" ? 5 : 6);
	if (changed.some((s) => s !== "user")) return false;
	const userIdx = changed.find((s) => s === "user");
	return userIdx !== undefined && changed.length === 1;
}