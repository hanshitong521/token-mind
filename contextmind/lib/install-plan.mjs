/**
 * The installation plan — one description of what ContextMind puts into a
 * project, consumed by install, uninstall and doctor alike.
 *
 * Keeping it here means doctor can say "this is what should be there" and
 * uninstall can say "this is what I added" without either of them re-deriving
 * it, which is how the two usually drift apart.
 *
 * Matchers follow the Cursor contract verified 2026-09-01: preToolUse/postToolUse
 * match on tool type (`Shell`, `Read`, `Grep`, `Glob`, `Task`) and on MCP tools
 * with an explicit `MCP:` prefix. A bare `mysql_query` never matches.
 */

export const HOOK_FILES = [
	"cm-lib.mjs",
	"cm-pre-tool.mjs",
	"cm-post-tool.mjs",
	"cm-session-start.mjs",
	"cm-session-end.mjs",
	"cm-stop.mjs",
];

/**
 * Windows launcher for a hook. Cursor runs the command through a shell, so a
 * bare `.mjs` will not execute; on POSIX the `.mjs` is invoked directly.
 *
 * If node is not on PATH the wrapper exits 0 rather than failing — a missing
 * runtime must fail open, not block every tool call in the project.
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

export const HOOK_ENTRIES = [
	{
		event: "preToolUse",
		matcher: "Read|Grep|Glob|Shell",
		failClosed: false,
		hook: "cm-pre-tool",
		purpose: "Read Guard, Grep/Glob bounds, Shell single-layer wrap",
	},
	{
		event: "preToolUse",
		matcher: "Task",
		failClosed: false,
		hook: "cm-pre-tool",
		purpose: "Block explore subagents replacing CodeGraph",
	},
	{
		event: "postToolUse",
		matcher: "MCP:mysql_query|MCP:semantic_search|MCP:get_evidence|MCP:ads-mysql|MCP:ads-mysql-prod",
		failClosed: false,
		hook: "cm-post-tool",
		purpose: "MCP Output Guard",
	},
	{
		event: "sessionStart",
		failClosed: false,
		hook: "cm-session-start",
		purpose: "Adapter probe",
	},
	{
		event: "sessionEnd",
		failClosed: false,
		hook: "cm-session-end",
		purpose: "Clear session dedup, gc handles",
	},
	{
		event: "stop",
		failClosed: false,
		hook: "cm-stop",
		purpose: "Completion gate (inert without a gate state file)",
	},
];

/** Command string written into hooks.json, relative to the project root. */
export function commandFor(hook, platform = process.platform) {
	return platform === "win32" ? `.cursor/hooks/${hook}.cmd` : `node .cursor/hooks/${hook}.mjs`;
}

/**
 * Does a hooks.json entry belong to ContextMind?
 *
 * Separator-agnostic on purpose. `commandFor` emits `.cursor/hooks/cm-*.cmd`,
 * and matching on `/.cursor/hooks/cm-` silently fails to recognise it — the old
 * entries were then kept *and* the new ones appended on every install, so the
 * hook ran twice per event and uninstall left it behind.
 */
export function isOwnHook(entry) {
	return /hooks[/\\]cm-[a-z-]+/.test(String(entry?.command ?? ""));
}

/**
 * Predecessor hooks this installation replaces.
 *
 * shejiuPro runs `gate-pre-tool` / `gate-mcp-output` / `gate-mysql-output` from
 * an external repo path. Leaving them registered next to the new hooks means
 * every tool call is governed twice, by two rules that disagree — worse than
 * either alone. They are retired on install and restored from the hooks.json
 * backup on uninstall.
 */
export const LEGACY_HOOK_RE = /hooks[/\\]gate-(pre-tool|mcp-output|mysql-output)/;

/** Rules are opt-in: the target project may already carry an always rule. */
export const RULES_OPT_IN = true;

export const MANIFEST_VERSION = 1;
export const MANIFEST_NAME = "contextmind-manifest.json";
