/**
 * Agent runtime graph (LangGraph-shaped, no LangGraph dep).
 * Nodes = phases; edges = allowed transitions. SSOT for task_state.phase hints.
 */
export const NODES = ["requirement", "rule", "state", "plan", "execute", "verify", "memory"];

const EDGES = {
	requirement: ["plan", "state"],
	rule: ["execute"],
	state: ["plan", "execute"],
	plan: ["execute"],
	execute: ["verify", "memory", "plan"],
	verify: ["execute", "memory", "state"],
	memory: ["state", "plan"],
};

export function normalizePhase(phase) {
	const map = {
		design: "plan",
		implement: "execute",
		debug: "execute",
		verify: "verify",
		ship: "memory",
	};
	return map[phase] ?? phase;
}

export function canTransition(from, to) {
	const f = normalizePhase(from);
	const t = normalizePhase(to);
	return (EDGES[f] ?? []).includes(t) || f === t;
}

export function suggestNextPhase(taskState, projectState) {
	const p = normalizePhase(taskState?.phase ?? "execute");
	if (p === "verify" && projectState?.current?.includes("eval")) return "memory";
	if (p === "execute" && taskState?.last_verified) return "verify";
	return p;
}
