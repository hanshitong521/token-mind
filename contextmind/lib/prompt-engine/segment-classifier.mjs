/**
 * Segment Classifier — rule-based stability labeling for blocks.
 *
 * Prompt Lab spec §10 & §16: every block must carry a stability class so the
 * cache analyzer can compute a stable-prefix story. Classification is
 * deterministic (a rule table plus light content heuristics), not LLM-driven,
 * so the same input always yields the same plan.
 *
 * Spec §16 default layout (L0..L7) maps kind → recommended slot; the
 * classifier returns both the class and its recommended layout slot.
 */

export const STABILITY = Object.freeze({
	STATIC: "STATIC",
	MOSTLY_STATIC: "MOSTLY_STATIC",
	DYNAMIC: "DYNAMIC",
	EPHEMERAL: "EPHEMERAL",
});

export const LAYOUT_SLOTS = Object.freeze([
	{ label: "L0 PROVIDER / SYSTEM", stability: STABILITY.STATIC },
	{ label: "L1 CORE RULES", stability: STABILITY.STATIC },
	{ label: "L2 TOOLS / MCP", stability: STABILITY.MOSTLY_STATIC },
	{ label: "L3 PROJECT CONTRACT / WIKI", stability: STABILITY.MOSTLY_STATIC },
	{ label: "L4 TASK SUMMARY", stability: STABILITY.DYNAMIC },
	{ label: "L5 BRAIN / RAG / CODE CONTEXT", stability: STABILITY.DYNAMIC },
	{ label: "L6 TOOL RESULTS / DIFF / LOGS", stability: STABILITY.EPHEMERAL },
	{ label: "L7 CURRENT USER REQUEST", stability: STABILITY.DYNAMIC },
]);

export const STABILITIES = Object.freeze(["STATIC", "MOSTLY_STATIC", "DYNAMIC", "EPHEMERAL"]);

const KIND_STABILITY = Object.freeze({
	instruction: STABILITY.STATIC,
	rule: STABILITY.STATIC,
	tool_schema: STABILITY.MOSTLY_STATIC,
	repo_map: STABILITY.MOSTLY_STATIC,
	project_contract: STABILITY.MOSTLY_STATIC,
	wiki: STABILITY.MOSTLY_STATIC,
	code: STABILITY.STATIC,
	example: STABILITY.MOSTLY_STATIC,
	task_summary: STABILITY.DYNAMIC,
	brain_memory: STABILITY.DYNAMIC,
	rag: STABILITY.DYNAMIC,
	history: STABILITY.EPHEMERAL,
	tool_result: STABILITY.EPHEMERAL,
	runtime_metadata: STABILITY.EPHEMERAL,
	user_request: STABILITY.DYNAMIC,
	diff: STABILITY.EPHEMERAL,
});

const KIND_SLOT = Object.freeze({
	instruction: "L0",
	rule: "L1",
	tool_schema: "L2",
	repo_map: "L3",
	project_contract: "L3",
	wiki: "L3",
	code: "L1",
	example: "L3",
	brain_memory: "L5",
	rag: "L5",
	history: "L6",
	tool_result: "L6",
	runtime_metadata: "L6",
	diff: "L6",
	user_request: "L7",
	task_summary: "L4",
});

/**
 * Classify a single block.
 *
 * Two answers are returned because they answer different questions:
 *  - `stability`  — DECLARED class from the kind table. "This content is
 *    supposed to be static." Cache rules (CACHE-001/003) compare against it:
 *    a block that claims to be static but carries a timestamp is exactly the
 *    CACHE_PREFIX_BREAKER we are hunting.
 *  - `effective`  — CONTENT-AWARE class. Volatile evidence demotes
 *    STATIC → DYNAMIC/EPHEMERAL (never promotes). This is what the stable
 *    prefix calculation must use, otherwise a prompt full of timestamps would
 *    advertise an 100% stable prefix.
 *
 * `block.stability` (set by the parser from content) is the effective class;
 * pass `override: true` to re-derive purely from the kind table.
 */
export function classifyBlock(block, { override = false } = {}) {
	const declared = KIND_STABILITY[block?.kind] ?? STABILITY.DYNAMIC;
	const slot = KIND_SLOT[block?.kind] ?? "L5";
	const effective =
		!override && STABILITIES.includes(block?.stability) ? block.stability : declared;
	return { stability: declared, effective, declared, slot };
}

/** The declared (kind-table) class only — used by cache rules. */
export function declaredStability(block) {
	return KIND_STABILITY[block?.kind] ?? STABILITY.DYNAMIC;
}

/** Classify every block of a manifest, mutating nothing; returns a map. */
export function classifyManifest(manifest) {
	const map = {};
	for (const block of manifest?.blocks ?? []) {
		map[block.id] = classifyBlock(block);
	}
	return map;
}

/**
 * Recommended layout for the whole manifest: an ordered list of block ids
 * following the spec §16 stable-first ordering (same-stability order kept).
 */
export function recommendLayout(manifest) {
	const blocks = manifest?.blocks ?? [];
	const ranked = blocks.map((b) => {
		const { stability, slot } = classifyBlock(b);
		return { ...b, _slotRank: LAYOUT_SLOTS.findIndex((s) => s.label.startsWith(slot)) ?? 99 };
	});
	ranked.sort((a, b) => a._slotRank - b._slotRank);
	return ranked.map((b) => ({ id: b.id, kind: b.kind, slot: b._slotRank }));
}