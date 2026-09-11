/**
 * Installation plan — peak Agent Stack (ContextMind + cache pipeline hooks).
 * Consumed by install / uninstall / doctor.
 */

/** Real hook entrypoints only. Empty cm-hookd / cmhook-client stubs removed (burst damage → 5s hang). */
export const HOOK_FILES = [
	"cm-lib.mjs",
	"cm-pre-tool.mjs",
	"cm-post-tool.mjs",
	"cm-session-start.mjs",
	"cm-session-end.mjs",
	"cm-before-submit-prompt.mjs",
	"cm-stop.mjs",
];

/**
 * Direct node → hook.mjs. Do NOT route through cmhook-client / bun / cmhook.exe:
 * those files were wiped to CRLF stubs and caused warm p50≈5s.
 */
export function launcherFor(hookName) {
	return `@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 exit /b 0
node "%~dp0${hookName}.mjs"
exit /b %ERRORLEVEL%
`;
}

/**
 * One entry per (event, hook, failClosed) — entries that agree on all three
 * carry a single union matcher, because install writes the list verbatim and a
 * second entry would only duplicate the command. `failClosed` is the one field
 * that must not be flattened: the raw-CodeGraph block is deliberately
 * fail-closed while every other pre-deny stays fail-open, so those two stay
 * apart. Cursor matches `Shell|Read|...` and `MCP:<tool>` against the same
 * alternation, so a union matcher governs exactly the union of the parts.
 */
export const HOOK_ENTRIES = [
	{
		event: "preToolUse",
		matcher:
			"Read|Grep|Glob|Shell|CallMcpTool|Task|MCP:context_orient|MCP:context_fetch|MCP:context_find|MCP:context_get|MCP:context_impact|MCP:context_run",
		failClosed: false,
		hook: "cm-pre-tool",
		purpose: "Read Guard, Grep/Glob bounds, Shell wrap, Task block, native MCP context_* pre-deny (L2)",
	},
	{
		event: "preToolUse",
		matcher:
			"MCP:codegraph_explore|MCP:codegraph_query|MCP:codegraph_impact|MCP:codegraph_callers|MCP:codegraph_callees",
		failClosed: true,
		hook: "cm-pre-tool",
		purpose: "Block raw CodeGraph MCP; force context_orient (fail-closed)",
	},
	{
		event: "postToolUse",
		matcher: "Shell|CallMcpTool",
		failClosed: false,
		hook: "cm-post-tool",
		purpose: "Shell exit audit",
	},
	{
		event: "postToolUse",
		matcher:
			"MCP:mysql_query|MCP:semantic_search|MCP:get_evidence|MCP:codegraph_explore|MCP:ads-mysql|MCP:ads-mysql-prod|MCP:context_orient|MCP:context_fetch|MCP:context_find|MCP:context_get|MCP:context_impact|MCP:context_run|MCP:search_project_context|MCP:get_change_context|MCP:save_architecture_decision|MCP:save_bug_memory|MCP:record_task_outcome",
		failClosed: false,
		hook: "cm-post-tool",
		purpose: "MCP Output Guard",
	},
	{
		event: "sessionStart",
		failClosed: false,
		hook: "cm-session-start",
		purpose: "Adapter probe + stack route preamble",
	},
	{
		event: "sessionEnd",
		failClosed: false,
		hook: "cm-session-end",
		purpose: "Clear session dedup, gc handles, cache ledger snapshot",
	},
	{
		event: "beforeSubmitPrompt",
		failClosed: false,
		hook: "cm-before-submit-prompt",
		purpose: "Prompt pipeline: exact cache + stable prefix + session delta (fail-open)",
	},
	{
		event: "stop",
		failClosed: false,
		hook: "cm-stop",
		purpose: "Completion gate (inert without current_gate_state.json)",
	},
];

export function commandFor(hook, platform = process.platform) {
	return platform === "win32" ? `.cursor/hooks/${hook}.cmd` : `node .cursor/hooks/${hook}.mjs`;
}

export function isOwnHook(entry) {
	return /hooks[/\\]cm-[a-z-]+/.test(String(entry?.command ?? ""));
}

export const LEGACY_HOOK_RE = /hooks[/\\]gate-(pre-tool|mcp-output|mysql-output)/;

export const RULES_OPT_IN = true;

export const MANIFEST_VERSION = 1;
export const MANIFEST_NAME = "contextmind-manifest.json";
