/**
 * Pre-tool fast allow (no Runtime HTTP, no TaskBundle).
 * AI-NOTE: Keep in sync with native/cmhook.rs TryFastAllowPre + peak plan S3.
 * AFTER CHANGE: tests/fast-allow-pre.test.mjs; hook-latency-peak on lite MCP call.
 */

const BRAIN_WHY_TOOLS = new Set([
	"search_project_context",
	"get_change_context",
	"save_architecture_decision",
	"save_bug_memory",
	"record_task_outcome",
]);

const CONTEXTMIND_PRE_LITE = new Set([
	"context_find",
	"context_get",
	"context_impact",
	"context_run",
	"context_outline",
]);

export function hookToolName(input) {
	return String(input?.tool_name ?? input?.toolName ?? input?.tool ?? "");
}

export function hookArgsOf(input) {
	return input?.tool_input ?? input?.arguments ?? {};
}

function normPath(p) {
	return String(p ?? "").replace(/\\/g, "/");
}

function callMcpTarget(args) {
	return {
		server: String(args.server ?? args.mcp_server ?? "").toLowerCase(),
		tool: String(args.toolName ?? args.tool_name ?? "").toLowerCase(),
	};
}

function contextFetchPreLite(args) {
	const inner = args.arguments ?? args.tool_input ?? {};
	return inner?.full !== true;
}

/** Read-only git / doctor diagnostics — no wrap, no execution log needed (S3 / G4 bench). */
const SAFE_SHELL_RE = [
	/^\s*git\s+(status|branch|rev-parse|stash\s+list|remote\s+-v|config\s+--get)(\s|$)/i,
	/^\s*git\s+log\b/i,
	/^\s*git\s+diff(\s|$)/i,
	/^\s*git\s+diff\s+--/i,
	/^\s*git\s+show\b/i,
	/^\s*node\s+\.cursor\/contextmind\/cli\.mjs\s+(doctor|report|start)(\s|$)/i,
];

function canFastAllowShell(name, args) {
	if (name !== "shell") return false;
	const cmd = String(args?.command ?? "").trim();
	if (!cmd || /\||;|&&|>|</.test(cmd)) return false;
	return SAFE_SHELL_RE.some((re) => re.test(cmd));
}

function canFastAllowCallMcp(name, args) {
	if (name !== "callmcptool") return false;
	const { server, tool } = callMcpTarget(args);
	if (server.includes("project-brain") && BRAIN_WHY_TOOLS.has(tool)) return true;
	if (server.includes("ads-mysql")) return true;
	if (server.includes("contextmind") && CONTEXTMIND_PRE_LITE.has(tool)) return true;
	if (server.includes("contextmind") && tool === "context_fetch" && contextFetchPreLite(args)) return true;
	return false;
}

/** @param {string} name lowercased tool name */
export function canFastAllowPre(name, args) {
	const n = String(name ?? "").toLowerCase();
	if (canFastAllowShell(n, args ?? {})) return true;
	if (canFastAllowCallMcp(n, args ?? {})) return true;
	if (n === "write" || n.includes("write") || n.includes("strreplace")) {
		const p = normPath(String(args.path ?? args.file_path ?? args.target ?? ""));
		if (!/\.java$/i.test(p)) return true;
	}
	return false;
}

/** Post-tool: Shell audit is telemetry-only in daemon (H9) — skip RPC entirely. */
export function canFastAllowPost(name, _args) {
	const n = String(name ?? "").toLowerCase();
	return n === "shell" || n.includes("shell");
}

export function canFastAllowHookInput(input, phase = "pre") {
	const name = hookToolName(input).toLowerCase();
	if (!name) return false;
	if (phase === "post") return canFastAllowPost(name, hookArgsOf(input));
	return canFastAllowPre(name, hookArgsOf(input));
}
