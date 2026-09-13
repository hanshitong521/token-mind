/**
 * Installation plan — peak Agent Stack (ContextMind + cache pipeline hooks).
 * Consumed by install / uninstall / doctor.
 */

/** Real hook entrypoints only. Empty cm-hookd / cmhook-client stubs removed (burst damage → 5s hang). */
export const HOOK_FILES = [
	"cm-rpc.mjs",
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
/** Resolve Node for hook fallback: CONTEXTMIND_NODE → D:\nodejs → PATH (avoid Python nodejs_wheel). */
function nodeResolveBlock(hookMjs) {
	return `set "CM_NODE="
if defined CONTEXTMIND_NODE if exist "%CONTEXTMIND_NODE%" set "CM_NODE=%CONTEXTMIND_NODE%"
if not defined CM_NODE if exist "D:\\nodejs\\node.exe" set "CM_NODE=D:\\nodejs\\node.exe"
if not defined CM_NODE (
  where node >nul 2>&1
  if errorlevel 1 exit /b 0
  set "CM_NODE=node"
)
"%CM_NODE%" "%~dp0${hookMjs}"
exit /b %ERRORLEVEL%
`;
}

/** Default node thin client; cmhook only after `install` verifies native build. */
export function launcherFor(hookName) {
	return launcherForNodeOnly(hookName);
}

/** Safe launcher — never invokes cmhook (use after `fix-hooks` or when verify fails). */
export function launcherForNodeOnly(hookName) {
	return `@echo off
setlocal
${nodeResolveBlock(`${hookName}.mjs`)}`;
}

const dotnetRootForCmhook = `if exist "%USERPROFILE%\\.dotnet\\shared\\Microsoft.NETCore.App" set "DOTNET_ROOT=%USERPROFILE%\\.dotnet"
`;

/**
 * Native client first: it is the fast path (~16 ms measured, against ~215 ms for node, which
 * pays process start plus module load). It now speaks both hosts' egress contracts — cmhook
 * rewrites the envelope for Qoder, because Qoder silently ignores Cursor's `{permission}` and a
 * deny that is ignored looks exactly like governance that is installed and doing nothing.
 * `install` verifies that translation before the native client is enabled, so an older build
 * cannot quietly take over Qoder's hook path again.
 */
export function launcherForVerifiedNative(hookName) {
	return `@echo off
setlocal
if exist "%~dp0.cmhook-json-ok" if exist "%~dp0cmhook.exe" (
  ${dotnetRootForCmhook}  "%~dp0cmhook.exe" ${hookName}
  exit /b %ERRORLEVEL%
)
${nodeResolveBlock(`${hookName}.mjs`)}`;
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
			"Shell|CallMcpTool|CallDynamicTool|Task|MCP:context_orient|MCP:context_fetch|MCP:context_find|MCP:context_get|MCP:context_impact|MCP:context_run|MCP:context_outline",
		failClosed: false,
		hook: "cm-pre-tool",
		purpose: "Shell wrap + Task/MCP pre-deny (L2). Read/Grep/Glob out of preTool (hang doc P0)",
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
		matcher: "Shell|CallMcpTool|CallDynamicTool",
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

/** @returns {{ command: string, args?: string[] }} */
export function commandFor(hook, platform = process.platform, { native = false } = {}) {
	if (native && platform === "win32") {
		return { command: ".cursor/hooks/cmhook.exe", args: [hook] };
	}
	if (platform === "win32") {
		return { command: `.cursor/hooks/${hook}.cmd` };
	}
	return { command: "node", args: [`.cursor/hooks/${hook}.mjs`] };
}

/** hooks.json row covers a planned hook (legacy .cmd/.mjs or native cmhook.exe + args). */
export function hookEntryPresent(entry, hookName) {
	const cmd = String(entry?.command ?? "");
	const args = Array.isArray(entry?.args) ? entry.args : [];
	if (cmd.includes(`hooks/${hookName}`)) return true;
	if (/cmhook\.exe/i.test(cmd) && args.includes(hookName)) return true;
	return false;
}

export function isOwnHook(entry) {
	const cmd = String(entry?.command ?? "");
	if (/hooks[/\\]cm-[a-z-]+/.test(cmd)) return true;
	if (/cmhook\.exe/i.test(cmd)) {
		const args = Array.isArray(entry?.args) ? entry.args : [];
		return args.some((a) => /^cm-/.test(String(a)));
	}
	return false;
}

export const LEGACY_HOOK_RE = /hooks[/\\]gate-(pre-tool|mcp-output|mysql-output)/;

/**
 * Qoder reads hooks from settings.json and speaks Claude Code's shape: PascalCase events and
 * a nested `{ async, hooks: [{ type: "command", ... }] }` entry. Verified against Qoder's own
 * bundled context plugin (`plugins/cache/qoderapp-bundler/qoder-context/<version>/hooks/hooks.json`).
 */
export const QODER_EVENT_MAP = {
	preToolUse: "PreToolUse",
	postToolUse: "PostToolUse",
	sessionStart: "SessionStart",
	sessionEnd: "SessionEnd",
	beforeSubmitPrompt: "UserPromptSubmit",
	stop: "Stop",
};

/**
 * Events that only record what already happened. They never decide anything, so they must not
 * make the host wait — a synchronous hook here taxes every single call.
 *
 * PostToolUse is deliberately NOT async. Qoder's async path
 * (`executeAsyncHooksInBackground`) harvests only `hookSpecificOutput.additionalContext`; a
 * replacement carried in `updatedToolOutput` / `updatedMCPToolOutput` is dropped on the floor.
 * Governance on PostToolUse *does* decide — it swaps the tool result the model sees — so it has
 * to run synchronously for the swap to land. Cost is the native client's ~54 ms p50 per matched
 * tool call (measured); making it async costs zero but silently disables output replacement.
 */
export const QODER_ASYNC_EVENTS = new Set(["SessionStart", "SessionEnd", "Stop"]);

/**
 * Cursor keeps Read/Grep/Glob out of preTool on purpose ("hang doc P0"), so those tools cost
 * nothing there. An entry with no matcher instead matches every tool, which on Qoder means a
 * hook process per Read/Grep/Edit/Write — measured p50 100–114 ms, all of it host-visible
 * latency, since the host waits on a synchronous hook. So both tool events carry Cursor's
 * coverage, spelled in the `tool_name` values Qoder actually sends (`Bash`, `mcp_call`) plus
 * Cursor's own names, which Qoder resolves through its alias table. The matcher is a JS regex
 * tested against the tool name, so anchor it: a bare `Task` would also capture TaskCreate.
 */
export const QODER_TOOL_MATCHER =
	"^(Bash|Shell|mcp_call|mcp_get|mcp_list|CallMcpTool|CallDynamicTool|Task|Agent)$";

/** Tool events that must not spawn a hook for tools outside QODER_TOOL_MATCHER. */
export const QODER_MATCHER_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

/**
 * Qoder *does* honour `matcher` — it is a regex matched against the tool name and every alias
 * that resolves to it — and omitting it matches everything. Cursor's two preToolUse entries
 * differ only by matcher and `failClosed`, and Qoder has no `failClosed`, so they still
 * collapse to one entry per (event, hook); copying them verbatim would spawn two hook
 * processes per tool call.
 */
export function dedupeForQoder(entries) {
	const seen = new Set();
	const out = [];
	for (const entry of entries) {
		const event = QODER_EVENT_MAP[entry.event];
		if (!event) continue;
		const key = `${event}|${entry.hook}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ event, hook: entry.hook });
	}
	return out;
}

/** One Qoder hook entry. Absolute paths: the hook's cwd is not guaranteed to be the project. */
export function qoderHookEntry(hook, event, projectRoot) {
	const root = String(projectRoot).replace(/[\\/]+$/, "");
	return {
		async: QODER_ASYNC_EVENTS.has(event),
		// Sibling of `hooks`, same level Qoder's loader reads it from.
		...(QODER_MATCHER_EVENTS.has(event) ? { matcher: QODER_TOOL_MATCHER } : {}),
		hooks: [
			{
				type: "command",
				command: "cmd.exe",
				args: ["/d", "/c", `${root}\\.cursor\\hooks\\${hook}.cmd`],
				name: `contextmind-${hook}`,
				timeout: 5,
				// The egress contract depends on the host: Qoder ignores `{permission}` and
				// reads `hookSpecificOutput.permissionDecision` instead.
				env: { CONTEXTMIND_HOST: "qoder" },
			},
		],
	};
}

/** True for entries this installer wrote, in either the nested or a flattened shape. */
export function isOwnQoderHook(entry) {
	const list = Array.isArray(entry?.hooks) ? entry.hooks : [entry];
	return list.some((h) => {
		if (String(h?.name ?? "").startsWith("contextmind-")) return true;
		const blob = `${h?.command ?? ""} ${Array.isArray(h?.args) ? h.args.join(" ") : ""}`;
		return /hooks[/\\]cm-/.test(blob);
	});
}

export const RULES_OPT_IN = true;

export const MANIFEST_VERSION = 1;
export const MANIFEST_NAME = "contextmind-manifest.json";
