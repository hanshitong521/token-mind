/**
 * Installation plan — peak Agent Stack (ContextMind + cache pipeline hooks).
 * Consumed by install / uninstall / doctor.
 *
 * Nothing here branches on a host: event spellings, async events, tool matcher, entry shape and
 * the host stamp all come from the registry (lib/hosts.mjs ← hosts.json), so host #3 is a data
 * edit. Host names survive below only as evidence attached to a measurement.
 */

import { hookEventName, isAsyncEvent, supports, toolMatcherFor } from "./hosts.mjs";

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

/**
 * Where the hook scripts live inside a governed project, shared by every host.
 *
 * The name is Cursor's because Cursor's install wrote the first copy, not because the scripts
 * belong to Cursor: cm-*.mjs reads its own config and takes the host from the payload/env, so one
 * set of files governs every host. A per-host directory would double what `uninstall` has to
 * clean and let two hosts run different builds of the same hook.
 */
export const HOOK_SCRIPT_DIR = ".cursor/hooks";

/** @returns {{ command: string, args?: string[] }} */
export function commandFor(hook, platform = process.platform, { native = false } = {}) {
	if (native && platform === "win32") {
		return { command: `${HOOK_SCRIPT_DIR}/cmhook.exe`, args: [hook] };
	}
	if (platform === "win32") {
		return { command: `${HOOK_SCRIPT_DIR}/${hook}.cmd` };
	}
	return { command: "node", args: [`${HOOK_SCRIPT_DIR}/${hook}.mjs`] };
}

/** hooks.json row covers a planned hook (legacy .cmd/.mjs or native cmhook.exe + args). */
export function hookEntryPresent(entry, hookName) {
	// Nested rows (Qoder/Claude Code) carry `command: "cmd.exe"` with the cm-* script buried in
	// `hooks[].args`, so a flat-only test reads a fresh install as "not installed".
	const rows = [entry, ...(Array.isArray(entry?.hooks) ? entry.hooks : [])];
	return rows.some((leaf) => {
		const cmd = String(leaf?.command ?? "");
		const args = Array.isArray(leaf?.args) ? leaf.args : [];
		if (new RegExp(`hooks[/\\\\]${hookName}`).test(`${cmd} ${args.join(" ")}`)) return true;
		if (/cmhook\.exe/i.test(cmd) && args.includes(hookName)) return true;
		return false;
	});
}

/** Flat rows only — the Cursor merge's own test. isOwnHookEntry() answers both shapes. */
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
 * Every leaf row this installer writes carries this name prefix, which is how `uninstall` picks its
 * own entries out of a config file it does not own. A host whose loader demands another naming
 * convention states `hooks.entryNamePrefix`.
 */
const ENTRY_NAME_PREFIX = "contextmind-";

const entryNamePrefixFor = (profile) => profile?.hooks?.entryNamePrefix ?? ENTRY_NAME_PREFIX;

/** Backslash-joined absolute path: the nested shape runs through cmd.exe, and the hook's cwd is not the project. */
function nestedScriptPath(projectRoot, hookDir, hook) {
	const root = String(projectRoot ?? "").replace(/[\\/]+$/, "");
	const dir = String(hookDir ?? HOOK_SCRIPT_DIR).replace(/^[\\/]+|[\\/]+$/g, "").replace(/[\\/]/g, "\\");
	return `${root}\\${dir}\\${hook}.cmd`;
}

/**
 * Host-neutral plan rows → the rows this host's config file gets, named in the host's spelling.
 *
 * Two things can drop a row. The host has no name for that event (`hookEventName` returns null),
 * which is how a hooks-capable host with fewer events than we govern degrades: it governs less,
 * it does not crash. And the host cannot carry what distinguishes two rows: the two preToolUse
 * rows differ only by `matcher` and `failClosed`, and a host with no `failClosed` field has to
 * collapse them to one row per (event, hook) — measured on the second host, copying them verbatim
 * spawns two hook processes per tool call for the same decision, and only one of them can be the
 * fail-closed one. Where the host does honour `failClosed` the rows stay apart, because the
 * raw-CodeGraph block is deliberately fail-closed while every other pre-deny stays fail-open.
 *
 * @param {any} profile host profile (null when the registry is unreadable → no rows, never a throw)
 * @param {any[]} entries HOOK_ENTRIES-shaped rows, canonical event names
 * @returns {any[]} `{event, hook}` in host spelling, plus `matcher`/`failClosed` when the host keeps them
 */
export function dedupeEntriesForHost(profile, entries) {
	if (!supports(profile, "hooks")) return [];
	const keepsFailClosed = supports(profile, "failClosed");
	const seen = new Set();
	const out = [];
	for (const entry of entries ?? []) {
		const event = hookEventName(profile, entry?.event);
		if (!event || !entry?.hook) continue;
		const key = keepsFailClosed
			? `${event}|${entry.hook}|${entry.matcher ?? ""}|${Boolean(entry.failClosed)}`
			: `${event}|${entry.hook}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(
			keepsFailClosed
				? { event, hook: entry.hook, matcher: entry.matcher ?? null, failClosed: Boolean(entry.failClosed) }
				: { event, hook: entry.hook },
		);
	}
	return out;
}

/**
 * One hook entry, in the shape this host's loader reads: `hooks.file.entryShape` picks between
 * the flat row (Cursor's `hooks.json`) and the nested `{ async, hooks: [{ type: "command", … }] }`
 * row (Claude Code's shape, read out of the host's settings file).
 *
 * `event` is the host spelling — what dedupeEntriesForHost just returned. Both decisions below are
 * keyed on it, so passing a canonical name through here loses the matcher and the async flag
 * silently rather than failing loudly.
 *
 * ASYNC is `profile.hooks.asyncEvents` — events that only record what already happened never
 * decide anything, so they must not make the host wait: a synchronous record-only hook taxes
 * every call. PostToolUse is deliberately absent from the nested host's list, and that is a
 * capability fact worth re-reading before adding an event there: its async path
 * (`executeAsyncHooksInBackground`) harvests only `hookSpecificOutput.additionalContext`, so a
 * replacement carried in `updatedToolOutput` / `updatedMCPToolOutput` is dropped on the floor.
 * Governance on PostToolUse *does* decide — it swaps the tool result the model sees — so it has to
 * run synchronously for the swap to land. Cost is the native client's ~54 ms p50 per matched tool
 * call (measured); async there costs zero but silently disables output replacement.
 *
 * MATCHER appears only where `toolMatcherFor` answers for the event. An entry with no matcher
 * matches every tool, and on a host that waits on synchronous hooks that is a hook process per
 * Read/Grep/Edit/Write — measured p50 100–114 ms, all of it host-visible latency. So the
 * profile spells its matcher in the `tool_name` values that host actually sends (including the
 * resolved `mcp__<server>__<tool>` names, which is what the host hands the hook rather than its
 * `mcp_call` meta-tool) and anchors it: the matcher is a JS regex tested against the tool name,
 * so a bare `Task` would also capture TaskCreate. A host with `matcherEvents: null` instead keeps
 * Cursor's per-row matchers, which leave Read/Grep/Glob out of preTool on purpose ("hang doc P0").
 *
 * ENV carries `profile.hooks.env` — the egress contract depends on the host (one ignores
 * `{permission}` and reads `hookSpecificOutput.permissionDecision`), and a host that needs no
 * stamp gets no key at all.
 *
 * @returns {any|null} null when the host has no hook surface — including an empty registry from an
 *   unreadable hosts.json. Governance absent is recoverable; an installer that throws mid-write
 *   leaves a half-written config behind.
 */
export function hookEntryFor(
	profile,
	{
		hook,
		event,
		projectRoot,
		hookDir = HOOK_SCRIPT_DIR,
		matcher = null,
		failClosed = null,
		platform = process.platform,
		native = false,
	} = {},
) {
	if (!supports(profile, "hooks") || !hook || !event) return null;
	const hostMatcher = toolMatcherFor(profile, event) ?? matcher;
	const env = { ...(profile?.hooks?.env ?? {}) };

	if (profile.hooks.file?.entryShape !== "claude-nested") {
		const entry = { ...commandFor(hook, platform, { native }) };
		if (hostMatcher) entry.matcher = hostMatcher;
		if (failClosed !== null) entry.failClosed = failClosed;
		if (Object.keys(env).length) entry.env = env;
		return entry;
	}

	const leaf = {
		type: "command",
		command: "cmd.exe",
		args: ["/d", "/c", nestedScriptPath(projectRoot, hookDir, hook)],
		name: `${entryNamePrefixFor(profile)}${hook}`,
		timeout: 5,
	};
	// Claude Code's real row schema has only a `command` string — no `args` array.
	// Qoder tolerates the extra key; a host that declares `leafCommandString` would
	// run bare `cmd.exe` and ignore the rest, so the row collapses into one quoted
	// command line instead. Own-entry recognition still matches: the cm-* path is
	// inside the joined string.
	//
	// `true` means the Claude default (`cmd.exe /d /c "<script>"`). A string is a
	// template with `{script}`, for hosts whose spawn is not plain cmd: WorkBuddy
	// runs hooks through Git Bash, where MSYS rewrites `/d` into a drive path and
	// the whole invocation dies, so its profile spells `cmd.exe //d //c "{script}"`
	// — verified on a real install, where the single-slash form never fired.
	const leafCommandString = profile.hooks.file?.leafCommandString;
	if (leafCommandString) {
		const script = leaf.args[2];
		leaf.command =
			typeof leafCommandString === "string"
				? leafCommandString.replaceAll("{script}", script)
				: `cmd.exe /d /c "${script}"`;
		delete leaf.args;
	}
	if (Object.keys(env).length) leaf.env = env;
	return {
		async: isAsyncEvent(profile, event),
		// Sibling of `hooks`, same level the host's loader reads it from.
		...(hostMatcher ? { matcher: hostMatcher } : {}),
		hooks: [leaf],
	};
}

/** A single command row, flat or nested: our name, our script path, or the native client plus our hook name as its argument. */
function isOwnHookLeaf(leaf, namePrefix) {
	if (!leaf || typeof leaf !== "object") return false;
	if (String(leaf.name ?? "").startsWith(namePrefix)) return true;
	const args = Array.isArray(leaf.args) ? leaf.args : [];
	if (/hooks[/\\]cm-/.test(`${leaf.command ?? ""} ${args.join(" ")}`)) return true;
	return /cmhook\.exe/i.test(String(leaf.command ?? "")) && args.some((a) => /^cm-/.test(String(a)));
}

/**
 * True for entries this installer wrote, in either shape.
 *
 * Both shapes have to be answered: in the nested one the row's own `command` is `cmd.exe` and the
 * cm-* path is buried in `args`, so a flat-only test leaves the old entry in place and the next
 * install doubles the hook — two processes per tool call, both writing to one ledger.
 */
export function isOwnHookEntry(profile, entry) {
	const prefix = entryNamePrefixFor(profile);
	const leaves = [entry, ...(Array.isArray(entry?.hooks) ? entry.hooks : [])];
	return leaves.some((leaf) => isOwnHookLeaf(leaf, prefix));
}

export const RULES_OPT_IN = true;

export const MANIFEST_VERSION = 1;
export const MANIFEST_NAME = "contextmind-manifest.json";
