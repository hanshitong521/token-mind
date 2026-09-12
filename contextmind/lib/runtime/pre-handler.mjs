/**
 * Pre-tool handler (daemon-side). Same rules as the former cm-pre-tool process.
 * Returns a Cursor hook payload; never writes stdout.
 */
import { tryDenyL2ToolCache } from "../cache-engine/pre-tool-l2.mjs";
import { orientSeenKey } from "../orient-key.mjs";
import { forbiddenAgentScanPath, FORBIDDEN_SCAN_HINT } from "../path-guards.mjs";
import { evaluateReadAdapter } from "../adapters/read.mjs";
import { clampGrepHead, grepKey, forbiddenGrep } from "../adapters/grep.mjs";
import { evaluateShellCommand, wrapDisclosure } from "../adapters/shell.mjs";
import {
	estimateImpact,
	estimateRisk,
	mustGovern,
	toolValueScore,
} from "../policy/adaptive.mjs";
import { loadWaiver } from "../stack-router.mjs";
import { evaluatePathScope, loadTaskBundle, taskIdFromLoaded, appendExecutionRecord } from "../task-bundle.mjs";
import { isResidentRule, getTrapForPath, trapMessage } from "../traps.mjs";
import { projectRootOf, sessionIdOf } from "../runtime.mjs";

class Decision {
	constructor(payload) {
		this.payload = payload;
	}
}

function deny(userMessage, agentMessage) {
	throw new Decision({ permission: "deny", user_message: userMessage, agent_message: agentMessage });
}

function allow(extra = {}) {
	throw new Decision({ permission: "allow", ...extra });
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

function isRepoRootPath(p) {
	const n = normPath(p).replace(/\/$/, "");
	if (!n) return true;
	return /\/shejiupro$/i.test(n) || /^[a-z]:\/worka\/shejiupro$/i.test(n);
}

/** Skip SQLite + guards when the tool cannot affect token/risk surfaces. */
function canFastAllowPre(name, args) {
	if (name === "write" || name.includes("write") || name.includes("strreplace")) {
		const p = normPath(String(args.path ?? args.file_path ?? args.target ?? ""));
		if (!/\.java$/i.test(p)) return true;
	}
	return false;
}

export async function handlePreTool(input, { openRuntime }) {
	try {
		return await runPre(input, openRuntime);
	} catch (err) {
		if (err instanceof Decision) return err.payload;
		return { permission: "allow", agent_message: `tokenmind pre-handler error: ${err?.message ?? err}` };
	}
}

async function runPre(input, openRuntimeFn) {
	const projectRoot = projectRootOf(input);
	const sessionId = sessionIdOf(input);
	const name = toolName(input).toLowerCase();
	const args = argsOf(input);

	if (canFastAllowPre(name, args)) {
		return {};
	}

	const rt = openRuntimeFn(projectRoot);
	const cfg = rt.cfg;

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
	const command = String(args.command ?? input.command ?? "");
	const unbounded = args.offset == null && args.limit == null;
	const value = toolValueScore({
		risk: estimateRisk({ toolName: name, command, unbounded }),
		contextImpact: estimateImpact({ unbounded }),
		repeats: 1,
	});
	input._tokenmind = { value, must: mustGovern(name, { command, server: innerServer }) };

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

	{
		const isFetch =
			(name === "callmcptool" && innerMcp.includes("context_fetch")) || name.includes("context_fetch");
		if (isFetch) {
			const innerArgs = name === "callmcptool" ? (args.arguments ?? args.tool_input ?? {}) : args;
			if (innerArgs?.full === true && cfg.fetch?.allow_full !== true) {
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
	}

	if (name === "callmcptool" && innerMcp.includes("context_")) {
		const innerArgs = args.arguments ?? args.tool_input ?? {};
		try {
			tryDenyL2ToolCache({
				rt,
				projectRoot,
				sessionId,
				innerMcp,
				innerArgs,
				record,
				deny: () =>
					deny(
						"ContextMind blocked a duplicate MCP tool call",
						"Identical context_* args are already in the L2 tool cache. Reuse that output or pass refresh.",
					),
			});
		} catch (err) {
			if (err instanceof Decision) throw err;
		}
	}

	{
		const isOrient =
			(name === "callmcptool" && innerMcp.includes("context_orient")) || name.includes("context_orient");
		if (isOrient) {
			const innerArgs = name === "callmcptool" ? (args.arguments ?? args.tool_input ?? {}) : args;
			const rawQ = String(innerArgs.query ?? innerArgs.symbol ?? "").slice(0, 200);
			const refresh = innerArgs.refresh === true;
			let okey = "";
			try {
				okey = orientSeenKey(rawQ);
			} catch {
				okey = "";
			}
			const prev = okey && !refresh ? rt.seen?.lookup(sessionId, "orient", okey) : null;
			if (prev) {
				record({
					surface: "mcp",
					toolName: "context_orient",
					sessionId,
					success: false,
					note: "orient_dup",
					preventedReadTokens: cfg.cache_engine?.orientSkipTokensEstimate ?? 364,
				});
				const handleHint = prev.handle_id ? ` Prior handle=${prev.handle_id}.` : "";
				deny(
					"ContextMind blocked duplicate context_orient",
					`Same symbol already oriented this session (${prev.hits}×, key=${okey}).${handleHint} Use context_fetch with a line selector. Pass refresh=true only if the graph changed.`,
				);
			}
			if (okey) rt.seen?.touch(sessionId, "orient", okey);
			record({
				surface: "mcp",
				toolName: "context_orient",
				sessionId,
				success: true,
				note: "orient_ok",
			});
		}
	}

	if (name === "write" || name === "strreplace" || name.includes("write") || name.includes("strreplace")) {
		const filePath = String(args.path ?? args.file_path ?? args.target ?? "");
		const npath = normPath(filePath);
		if (/\.java$/i.test(npath)) {
			const hasBundle = Boolean(taskBundleDoc?.intent?.goal);
			let waiverOk = false;
			try {
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

	if (name === "read" || name.includes("read")) {
		const filePath = String(args.path ?? args.file_path ?? args.target ?? "");
		if (filePath) {
			const fbRead = forbiddenAgentScanPath(filePath);
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
					`${fbRead.reason}. ${FORBIDDEN_SCAN_HINT}`,
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

			const verdict = evaluateReadAdapter({
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

	if (name === "grep" || name.includes("grep")) {
		const next = { ...args };
		next.head_limit = clampGrepHead(next.head_limit);

		const grepScanPath = String(next.path || next.target_directory || "");
		const fbGrep = forbiddenGrep(grepScanPath);
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
				`${fbGrep.reason}. ${FORBIDDEN_SCAN_HINT}`,
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

	if (name === "glob" || name.includes("glob")) {
		const pattern = String(args.glob_pattern ?? args.glob ?? "");
		const target = String(args.target_directory ?? "");
		const fbGlob = forbiddenAgentScanPath(target);
		if (fbGlob.blocked) {
			deny(
				"ContextMind blocked Glob under agent-transcripts / Cursor project metadata",
				`${fbGlob.reason}. ${FORBIDDEN_SCAN_HINT}`,
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

	if (name === "shell" || name === "bash" || name.includes("shell")) {
		if (command.trim()) {
			if (/agent-transcripts/i.test(command)) {
				deny(
					"ContextMind blocked shell access to agent-transcripts",
					FORBIDDEN_SCAN_HINT,
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

			const gitDiag = /^\s*git\b/i.test(command.trim());
			if (gitDiag && cfg.shell?.wrap_git !== true) {
				appendExecutionRecord(projectRoot, cfg, {
					kind: "shell",
					command: command.slice(0, 500),
				});
				allow();
			}

			const verdict = evaluateShellCommand(command, { cfg });
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

	return {};
}
