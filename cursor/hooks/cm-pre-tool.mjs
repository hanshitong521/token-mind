#!/usr/bin/env node
/**
 * ContextMind preToolUse hook.
 *
 * Cursor contract (verified 2026-09-01, https://cursor.com/docs/hooks):
 *   input  { tool_name, tool_input, cwd, conversation_id, workspace_roots, ... }
 *   output { permission: "allow"|"deny", user_message, agent_message, updated_input }
 *
 * Exits 0 in every case and states the decision in the payload — exit code 2
 * also blocks, but then the JSON is not what carries the decision and the
 * agent-facing guidance is lost.
 *
 * Fail-open by design except for unbounded reads, which are decidable from
 * local static rules alone (spec 44). Every telemetry failure is swallowed
 * here; it must never be the reason a tool call breaks.
 */

import { dumpStages, readGuard, ready, runtime, shellGuard, stages, traps } from "./cm-lib.mjs";

// Library not found: fail open. A mis-installed governance layer must not take
// the user's tool calls down with it.
if (!ready) {
	process.stdout.write("{}\n");
	process.exit(0);
}

const { emit, noop, openRuntime, projectRootOf, readHookInput, sessionIdOf } = runtime;
const { evaluateRead } = readGuard;
const { evaluateShell, wrapDisclosure } = shellGuard;
const { isResidentRule, getTrapForPath, trapMessage } = traps;

const GREP_DEFAULT_HEAD = 30;
const GREP_MAX_HEAD = 80;

function deny(userMessage, agentMessage) {
	stages.workMs = performance.now() - tWork;
	dumpStages("cm-pre-tool:deny");
	emit({ permission: "deny", user_message: userMessage, agent_message: agentMessage });
	process.exit(0);
}

function allow(extra = {}) {
	stages.workMs = performance.now() - tWork;
	dumpStages("cm-pre-tool:allow");
	emit({ permission: "allow", ...extra });
	process.exit(0);
}

function toolName(input) {
	return String(input.tool_name ?? input.toolName ?? input.tool ?? "");
}

function argsOf(input) {
	return input.tool_input ?? input.arguments ?? {};
}

function normPath(p) {
	return String(p ?? "").replace(/\\/g, "/");
}

const input = await readHookInput();
const projectRoot = projectRootOf(input);
const tRuntime = performance.now();
const rt = openRuntime(projectRoot);
stages.runtimeMs = performance.now() - tRuntime;
const tWork = performance.now();
const cfg = rt.cfg;
const sessionId = sessionIdOf(input);
const name = toolName(input).toLowerCase();
const args = argsOf(input);

const record = (ev) => {
	try {
		rt.telemetry.record(ev);
	} catch {
		/* telemetry is never load-bearing */
	}
};

// ─── Read ───
if (name === "read" || name.includes("read")) {
	const filePath = String(args.path ?? args.file_path ?? args.target ?? "");
	if (filePath) {
		if (isResidentRule(filePath)) {
			record({
				surface: "read",
				toolName: "Read",
				sessionId,
				preventedReadTokens: 0,
				readBlocked: 1,
				success: false,
				note: `resident rule re-read: ${filePath}`,
			});
			deny(
				`ContextMind blocked re-reading resident rule ${filePath}`,
				"This rule is already in your always-on context. Do not re-read it; act on the text you already have.",
			);
		}

		const trap = getTrapForPath(filePath);
		if (trap) {
			record({
				surface: "read",
				toolName: "Read",
				sessionId,
				preventedReadTokens: trap.baseline_tokens,
				readBlocked: 1,
				success: false,
				note: `trap:${trap.kind}`,
			});
			deny(
				`ContextMind blocked whole-file read of ${filePath} (~${trap.baseline_tokens} tokens)`,
				trapMessage(filePath),
			);
		}

		const verdict = evaluateRead({ filePath, offset: args.offset, limit: args.limit, cfg, toolInput: args });
		if (verdict.decision === "deny") {
			record({
				surface: "read",
				toolName: "Read",
				sessionId,
				preventedReadTokens: verdict.preventedTokens,
				readBlocked: 1,
				success: false,
				note: `rule:${verdict.rule}`,
			});
			deny(
				`ContextMind blocked unbounded read of ${filePath} (~${verdict.fileTokens} tokens)`,
				`${verdict.reason}. ${verdict.message ?? ""}`.trim(),
			);
		}
		// An override is allowed but counted, so a rule that misfires is visible
		// instead of being quietly worked around forever.
		if (verdict.rule === "override") {
			record({
				surface: "read",
				toolName: "Read",
				sessionId,
				readOverride: 1,
				success: true,
				note: `override:${verdict.reason}`,
			});
		}
	}
	allow();
}

// ─── Grep ───
if (name === "grep" || name.includes("grep")) {
	const limit = Number(args.head_limit);
	const has = Number.isFinite(limit) && limit > 0;
	if (!has) {
		allow({ updated_input: { ...args, head_limit: GREP_DEFAULT_HEAD } });
	}
	if (limit > GREP_MAX_HEAD) {
		allow({ updated_input: { ...args, head_limit: GREP_MAX_HEAD } });
	}
	allow();
}

// ─── Glob ───
if (name === "glob" || name.includes("glob")) {
	const pattern = String(args.glob_pattern ?? args.glob ?? "");
	const target = String(args.target_directory ?? "");
	if (
		pattern &&
		(!target || /shejiupro$/i.test(normPath(target))) &&
		(/^\*\*\/\*$/.test(pattern) || /^\*\*\/\*\.java$/.test(pattern) || pattern === "*.java")
	) {
		deny(
			`ContextMind blocked over-broad glob ${pattern}`,
			`No repo-wide globs. Use context_orient / CodeGraph explore with a FQCN (maxFiles=1), or scope the glob to one module directory.`,
		);
	}
	allow();
}

// ─── Shell ───
if (name === "shell" || name === "bash" || name.includes("shell")) {
	const command = String(args.command ?? input.command ?? "");
	if (command.trim()) {
		if (
			/\bdir\s+\/s\b/i.test(command) ||
			/Get-ChildItem[\s\S]{0,120}-Recurse/i.test(command) ||
			/\bfind\s+\.\s/i.test(command)
		) {
			deny(
				"ContextMind blocked a recursive directory dump",
				"No `dir /s`, `Get-ChildItem -Recurse`, or `find .` dumps. Use a scoped Glob, or context_orient.",
			);
		}

		const verdict = evaluateShell(command, { cfg });
		if (verdict.action === "wrap") {
			record({
				surface: "shell",
				toolName: "Shell",
				sessionId,
				rawTokens: 0,
				emittedTokens: 0,
				toolEmittedSavings: 0,
				firstLayer: cfg.shell.first_layer,
				success: true,
				note: "wrap_rewrite",
			});
			allow({
				updated_input: { ...args, command: verdict.command },
				additional_context: wrapDisclosure(verdict.reason),
			});
		}
	}
	allow();
}

// ─── Task (subagent) ───
if (name === "task") {
	const subagentType = String(args.subagent_type ?? args.subagentType ?? "");
	const blob = `${args.prompt ?? ""} ${args.description ?? ""}`;
	if (
		["explore", "code-explorer", "code-architect"].includes(subagentType) &&
		/java|serviceimpl|com\.shejiu|\.java\b/i.test(blob)
	) {
		deny(
			`ContextMind blocked subagent ${subagentType} for Java structure exploration`,
			"Java structure exploration goes through context_orient / CodeGraph explore in the host agent. A subagent does not satisfy that and must not replace it.",
		);
	}
}

noop();
