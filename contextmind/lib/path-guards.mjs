/**
 * Paths that must never be scanned by Grep/Glob/Read (unbounded) — they hang sessions
 * and do not contain product source truth.
 */

const FORBIDDEN_SEGMENTS = [
	"/agent-transcripts/",
	"\\agent-transcripts\\",
	"/.cursor/projects/",
	"\\.cursor\\projects\\",
	"/.forgemind/mcp-activity.jsonl",
	"\\.forgemind\\mcp-activity.jsonl",
];

export function normScanPath(p) {
	return String(p ?? "").replace(/\\/g, "/").toLowerCase();
}

/** @returns {{ blocked: boolean, reason: string }} */
export function forbiddenAgentScanPath(fileOrDir) {
	const n = normScanPath(fileOrDir);
	if (!n) return { blocked: false, reason: "" };
	for (const seg of FORBIDDEN_SEGMENTS) {
		const s = seg.replace(/\\/g, "/").toLowerCase();
		if (n.includes(s.replace(/\\/g, "/"))) {
			return {
				blocked: true,
				reason: "agent-transcripts and Cursor project metadata are out of scope — use task.active.json / RequirementMind / Brain MCP",
			};
		}
	}
	if (/\/agent-transcripts$/i.test(n) || /agent-transcripts\/?$/i.test(n)) {
		return { blocked: true, reason: "do not search agent-transcripts" };
	}
	return { blocked: false, reason: "" };
}

export const FORBIDDEN_SCAN_HINT =
	"Do not Grep/Read/Glob agent-transcripts or .cursor/projects/* logs. Use .contextmind/task.active.json, docs/requirementmind/, context_orient, or Brain semantic_search.";
