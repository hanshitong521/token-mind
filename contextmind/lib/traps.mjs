/**
 * Doc-read traps: files that are expensive to read and cheap to route around.
 *
 * Vendored from E:\workA\shejiuPro\.cursor\hooks\doc-read-traps.mjs (which was
 * itself a fallback for an external `work-mind` module resolved by absolute
 * path). That indirection is gone on purpose — a governance rule whose behaviour
 * depends on a sibling repo being present is a rule that silently disappears.
 *
 * This table is shejiuPro-specific. It is data, not an abstraction: when a
 * second project needs a different table, that is the point at which it moves
 * into `.contextmind.json` (spec 29.2 — no abstraction before two real
 * implementations).
 */

const TRAPS = [
	{
		kind: "workflows_full",
		match: (p) => (p.endsWith("workflows.md") || p.includes("/workflows.md")) && !p.includes("workflows-quick"),
		baseline_tokens: 5284,
		redirect: ".cursor/reference/workflows-quick.md",
		agent_hint: "Do not read workflows.md whole — query it (context_find) or read workflows-quick.md.",
	},
	{
		kind: "pitfalls_ssot",
		match: (p) => p.includes("pitfalls-shejiupro.md"),
		baseline_tokens: 5802,
		redirect: "context_find on the pitfall topic",
		agent_hint: "Do not read pitfalls-shejiuPro.md whole — query it.",
	},
	{
		kind: "pitfalls_legacy",
		match: (p) => p.includes("docs/agents/pitfalls.md"),
		baseline_tokens: 143,
		redirect: ".cursor/skills/ads-sql/pitfalls-shejiuPro.md (single line append)",
		agent_hint: "Do not read docs/agents/pitfalls.md.",
	},
	{
		kind: "ads_reference",
		match: (p) => p.includes("ads-sql/reference/") || p.includes(".cursor/skills/ads-sql/reference/"),
		baseline_tokens: 3500,
		redirect: "context_find, or attach a single volume",
		agent_hint: "Do not read ads-sql/reference/** whole.",
	},
];

/** Files already resident in the always-on context — re-reading them is pure waste. */
const RESIDENT_RULES = [
	"/.cursor/rules/token-budget.mdc",
	"/.cursor/rules/shejiu-core.mdc",
	"/.cursor/rules/codegraph.mdc",
	"/.cursor/rules/java-doc-log.mdc",
	"user-core.mdc",
	"caveman-ultra.mdc",
	"/token-budget/skill.md",
	"/ponytail/skill.md",
	"/caveman/skill.md",
];

export function normalizeDocPath(path) {
	return String(path ?? "")
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.toLowerCase();
}

export function getTrapForPath(path) {
	const p = normalizeDocPath(path);
	if (!p) return null;
	return TRAPS.find((t) => t.match(p)) ?? null;
}

export function isResidentRule(path) {
	const p = normalizeDocPath(path);
	return RESIDENT_RULES.some((h) => p.endsWith(h) || p.includes(h));
}

export function trapMessage(path) {
	const trap = getTrapForPath(path);
	const p = String(path ?? "").replace(/\\/g, "/");
	if (!trap) return `NO_SEARCH\nroute: READ\npath: ${p}`;
	return [
		"NO_SEARCH",
		"route: FORGE_NOT_READ",
		`trap: ${trap.kind}`,
		`path: ${p}`,
		`redirect: ${trap.redirect}`,
		trap.agent_hint,
	].join("\n");
}
