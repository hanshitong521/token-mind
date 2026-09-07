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

import { dumpStages, lib, readGuard, ready, runtime, shellGuard, stages, taskBundle, traps } from "./cm-lib.mjs";

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
const { loadTaskBundle, evaluatePathScope, appendExecutionRecord, taskIdFromLoaded } = taskBundle;

const GREP_DEFAULT_HEAD = 30;
const GREP_MAX_HEAD = 80;

function isRepoRootPath(p) {
	const n = normPath(p).replace(/\/$/, "");
	if (!n) return true;
	return /\/shejiupro$/i.test(n) || /^[a-z]:\/worka\/shejiupro$/i.test(n);
}

function grepKey(pattern, path, head) {
	return `${String(pattern ?? "").slice(0, 200)}|${normPath(path)}|${head}`;
}

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

const taskLoaded = loadTaskBundle(projectRoot, cfg);
const taskBundleDoc = taskLoaded?.bundle ?? null;
const activeTaskId = taskIdFromLoaded(taskLoaded);

const record = (ev) => {
	try {
		rt.telemetry.record({ taskId: activeTaskId, ...ev });
	} catch {
		/* telemetry is never load-bearing */
	}
};

const innerMcp = String(args.toolName ?? args.tool_name ?? "").toLowerCase();
const innerServer = String(args.server ?? args.mcp_server ?? "").toLowerCase();

// ─── Raw CodeGraph (CallMcpTool wrapper OR MCP:codegraph_*) ───
if (
	(name === "callmcptool" && (innerMcp.includes("codegraph") || innerServer.includes("codegraph"))) ||
	(name.includes("codegraph") && !name.includes("context_"))
) {
	record({
		surface: "mcp",
		toolName: innerMcp || toolName(input),
		sessionId,
		readBlocked: 1,
		success: false,
		note: "blocked_raw_codegraph",
	});
	deny(
		"ContextMind blocked a raw CodeGraph MCP call",
		"Do not CallMcpTool codegraph_explore/query/impact. Use context_orient (once per symbol), then context_fetch with a line selector. Pass refresh=true on context_orient only if the graph changed.",
	);
}

// ─── context_fetch full=true (token leak) ───
if (name === "callmcptool" && innerMcp.includes("context_fetch")) {
	const innerArgs = args.arguments ?? args.tool_input ?? {};
	if (innerArgs?.full === true) {
		record({
			surface: "mcp",
			toolName: "context_fetch",
			sessionId,
			readBlocked: 1,
			success: false,
			note: "blocked_fetch_full",
		});
		deny(
			"ContextMind blocked context_fetch full=true",
			"Use context_fetch with a line selector (start/end) or pattern. full=true is disabled unless fetch.allow_full is true in .contextmind.json.",
		);
	}
}

// ─── context_* L2 tool cache (identical args) ───
if (name === "callmcptool" && innerMcp.includes("context_")) {
	const innerArgs = args.arguments ?? args.tool_input ?? {};
	try {
		const { tryDenyL2ToolCache } = await lib("cache-engine/pre-tool-l2.mjs");
		if (tryDenyL2ToolCache({ rt, projectRoot, sessionId, innerMcp, innerArgs, record, deny })) {
			/* denied */
		}
	} catch {
		/* fail-open */
	}
}

// ─── context_orient (once-per-symbol telemetry) ───
if (name === "callmcptool" && innerMcp.includes("context_orient")) {
	const innerArgs = args.arguments ?? args.tool_input ?? {};
	const q = String(innerArgs.query ?? innerArgs.symbol ?? "").slice(0, 200);
	const refresh = innerArgs.refresh === true;
	const okey = `orient:${q || "(empty)"}`;
	const prev = q && !refresh ? rt.seen?.lookup(sessionId, "orient", okey) : null;
	if (prev) {
		record({
			surface: "mcp",
			toolName: "context_orient",
			sessionId,
			success: false,
			note: "orient_dup",
		});
		deny(
			"ContextMind blocked duplicate context_orient",
			`Same symbol already oriented this session (${prev.hits}×). Use context_fetch with a line selector. Pass refresh=true only if the graph changed.`,
		);
	}
	if (q) rt.seen?.touch(sessionId, "orient", okey);
	record({
		surface: "mcp",
		toolName: "context_orient",
		sessionId,
		success: true,
		note: "orient_ok",
	});
}

// ─── Write / StrReplace — optional TaskBundle gate for Java ───
if (name === "write" || name === "strreplace" || name.includes("write") || name.includes("strreplace")) {
	const filePath = String(args.path ?? args.file_path ?? args.target ?? "");
	const npath = normPath(filePath);
	if (/\.java$/i.test(npath)) {
		const hasBundle = Boolean(taskBundleDoc?.intent?.goal);
		let waiverOk = false;
		try {
			const { loadWaiver } = await lib("stack-router.mjs");
			waiverOk = loadWaiver(projectRoot).ok;
		} catch {
			/* optional */
		}
		if (!hasBundle && !waiverOk) {
			const enforce = cfg.sdlc?.enforce_write_bundle === true;
			record({
				surface: "write",
				toolName: toolName(input),
				sessionId,
				success: !enforce,
				note: enforce ? "write_denied_no_bundle" : "write_without_bundle",
			});
			if (enforce) {
				deny(
					"ContextMind blocked Java write without TaskBundle",
					"Create .contextmind/task.active.json (or micro .contextmind/waiver.json with reason+verify), then retry. Or set sdlc.enforce_write_bundle=false.",
				);
			}
		} else if (taskBundleDoc && filePath) {
			const scope = evaluatePathScope({
				filePath,
				projectRoot,
				bundle: taskBundleDoc,
				enforceAllow: cfg.sdlc?.enforce_allow !== false,
			});
			if (scope.decision === "deny") {
				record({
					surface: "write",
					toolName: toolName(input),
					sessionId,
					success: false,
					note: `task_scope:${scope.rule}`,
				});
				deny(
					"ContextMind blocked write outside TaskBundle scope",
					`${scope.reason}. Update allow_globs or narrow the edit.`,
				);
			}
		}
	}
}

const pathGuards = await lib("path-guards.mjs");

// ─── Read ───
if (name === "read" || name.includes("read")) {
	const filePath = String(args.path ?? args.file_path ?? args.target ?? "");
	if (filePath) {
		const fbRead = pathGuards.forbiddenAgentScanPath(filePath);
		if (fbRead.blocked && args.offset == null && args.limit == null) {
			record({
				surface: "read",
				toolName: "Read",
				sessionId,
				readBlocked: 1,
				success: false,
				note: "forbidden_scan_path",
			});
			deny(
				`ContextMind blocked Read of ${filePath}`,
				`${fbRead.reason}. ${pathGuards.FORBIDDEN_SCAN_HINT}`,
			);
		}

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

		const verdict = evaluateRead({
			filePath,
			offset: args.offset,
			limit: args.limit,
			cfg,
			toolInput: args,
			taskBundle: taskBundleDoc,
			projectRoot,
		});
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

		const unbounded = args.offset == null && args.limit == null;
		const npath = normPath(filePath);
		if (unbounded && !args.override_reason) {
			const prev = rt.seen?.lookup(sessionId, "path", npath);
			if (prev) {
				record({
					surface: "read",
					toolName: "Read",
					sessionId,
					readBlocked: 1,
					preventedReadTokens: verdict.fileTokens ?? 0,
					success: false,
					note: "session_reread",
				});
				deny(
					`ContextMind blocked a second unbounded Read of ${filePath}`,
					`This path was already read this session (${prev.hits}×). Use offset/limit, or context_fetch on handle ${prev.handle_id ?? "(none)"}. Do not re-read the whole file.`,
				);
			}
		}

		if (!args.override_reason && rt.seen && !unbounded) {
			const cover = rt.seen.coveringRead(sessionId, npath, args.offset, args.limit);
			if (cover?.coveredBy) {
				record({
					surface: "read",
					toolName: "Read",
					sessionId,
					readBlocked: 1,
					success: false,
					note: "covered_window",
				});
				deny(
					`ContextMind blocked a Read of ${filePath} lines ${cover.start}-${cover.end} already in this session`,
					`Those lines are already inside ${cover.coveredBy.start_line}-${cover.coveredBy.end_line} from an earlier Read. Do not re-fetch. StrReplace using the text you have, or Read a range that extends outside that window.`,
				);
			}
		}
		rt.seen?.recordRead(sessionId, npath, args.offset, args.limit);
	}
	allow();
}

// ─── Grep ───
if (name === "grep" || name.includes("grep")) {
	const next = { ...args };
	const limit = Number(next.head_limit);
	if (!Number.isFinite(limit) || limit <= 0) next.head_limit = GREP_DEFAULT_HEAD;
	else if (limit > GREP_MAX_HEAD) next.head_limit = GREP_MAX_HEAD;

	const grepScanPath = String(next.path || next.target_directory || "");
	const fbGrep = pathGuards.forbiddenAgentScanPath(grepScanPath);
	if (fbGrep.blocked) {
		record({
			surface: "grep",
			toolName: "Grep",
			sessionId,
			readBlocked: 1,
			success: false,
			note: "forbidden_scan_path",
		});
		deny(
			"ContextMind blocked Grep on agent-transcripts / Cursor project metadata",
			`${fbGrep.reason}. ${pathGuards.FORBIDDEN_SCAN_HINT}`,
		);
	}

	if (isRepoRootPath(next.path || next.target_directory || "") && !next.glob) {
		record({
			surface: "grep",
			toolName: "Grep",
			sessionId,
			readBlocked: 1,
			success: false,
			note: "grep_repo_root",
		});
		deny(
			"ContextMind blocked a repo-root Grep",
			"Do not Grep the whole shejiuPro tree. Set path to one module (shejiu-modules/shejiu-product) or one file. For a Java symbol use context_find / context_orient.",
		);
	}

	const grepPath = String(next.path || next.target_directory || "");
	if (taskBundleDoc && grepPath) {
		const scope = evaluatePathScope({
			filePath: grepPath,
			projectRoot,
			bundle: taskBundleDoc,
			enforceAllow: cfg.sdlc?.enforce_allow !== false,
		});
		if (scope.decision === "deny") {
			record({
				surface: "grep",
				toolName: "Grep",
				sessionId,
				readBlocked: 1,
				success: false,
				note: `task_scope:${scope.rule}`,
			});
			deny(
				"ContextMind blocked Grep outside TaskBundle scope",
				`${scope.reason}. Narrow path to an allowed glob or update .contextmind/task.active.json.`,
			);
		}
	}

	const gkey = grepKey(next.pattern, next.path, next.head_limit);
	if (!next.override_reason) {
		const prev = rt.seen?.lookup(sessionId, "grep", gkey);
		if (prev) {
			record({
				surface: "grep",
				toolName: "Grep",
				sessionId,
				readBlocked: 1,
				success: false,
				note: "grep_duplicate",
			});
			deny(
				"ContextMind blocked a duplicate Grep",
				`Identical pattern/path already ran this session (${prev.hits}×). Use those hits. Change path, pattern, or glob if you need a different slice.`,
			);
		}
		rt.seen?.touch(sessionId, "grep", gkey);
	}

	const mutated = next.head_limit !== args.head_limit;
	allow(mutated ? { updated_input: next } : {});
}

// ─── Glob ───
if (name === "glob" || name.includes("glob")) {
	const pattern = String(args.glob_pattern ?? args.glob ?? "");
	const target = String(args.target_directory ?? "");
	const fbGlob = pathGuards.forbiddenAgentScanPath(target);
	if (fbGlob.blocked) {
		deny(
			"ContextMind blocked Glob under agent-transcripts / Cursor project metadata",
			`${fbGlob.reason}. ${pathGuards.FORBIDDEN_SCAN_HINT}`,
		);
	}
	if (
		pattern &&
		(!target || /shejiupro$/i.test(normPath(target))) &&
		(/^\*\*\/\*$/.test(pattern) || /^\*\*\/\*\.java$/.test(pattern) || pattern === "*.java")
	) {
		deny(
			`ContextMind blocked over-broad glob ${pattern}`,
			`No repo-wide globs. Use context_orient with a FQCN, or scope the glob to one module directory.`,
		);
	}
	allow();
}

// ─── Shell ───
if (name === "shell" || name === "bash" || name.includes("shell")) {
	const command = String(args.command ?? input.command ?? "");
	if (command.trim()) {
		if (/agent-transcripts/i.test(command)) {
			deny(
				"ContextMind blocked shell access to agent-transcripts",
				pathGuards.FORBIDDEN_SCAN_HINT,
			);
		}
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
		appendExecutionRecord(projectRoot, cfg, {
			kind: "shell",
			command: command.slice(0, 500),
		});
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
