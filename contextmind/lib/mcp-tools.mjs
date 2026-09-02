/**
 * The six MCP tools ContextMind exposes to the Agent (spec 9, decision 5C).
 *
 * Everything upstream is an internal adapter: CodeGraph through its local CLI
 * (probed at call time — a missing binary is a status, never a fake success),
 * the compression engine through the Output Gate, raw evidence through the
 * handle store. Tool descriptions are written to a budget: the whole
 * tools/list payload must measure <= budget.mcp_schema_total tokens
 (2500), so every word here costs context on every turn.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { countTokens, truncateToTokens } from "./tokens.mjs";

export const SERVER_NAME = "contextmind";
export const SERVER_VERSION = "1.0.0";

/**
 * Characters that change shell meaning. Args reaching the codegraph adapter
 * come from the model; one guard at the shared spawn point is smaller and
 * safer than a per-tool escaping rule (and Windows .cmd shims force
 * shell:true anyway, so quoting alone would not save us).
 */
const SHELL_UNSAFE = /["&|<>^%!`\n\r]/;

function shellSafe(value) {
	const s = String(value);
	if (SHELL_UNSAFE.test(s)) {
		throw new Error(`rejected characters in argument: ${JSON.stringify(s.slice(0, 60))}`);
	}
	return s;
}

function codegraphBin(cfg) {
	return cfg.adapters?.codegraph?.bin ?? "codegraph";
}

/**
 * Locale-free existence probe. A `shell:true` spawn of a missing .cmd on
 * Windows returns exit 1 with localized stderr, which is indistinguishable
 * from "ran and failed" — so availability is decided by resolving the PATH
 * ourselves, and the two degrade statuses (ADAPTER_MISSING vs NO_INDEX)
 * never depend on the console language.
 */
const commandCache = new Map();
function commandAvailable(bin) {
	if (commandCache.has(bin)) return commandCache.get(bin);
	let ok = false;
	try {
		if (bin.includes("/") || bin.includes("\\")) {
			ok = existsSync(bin);
		} else {
			const win = process.platform === "win32";
			const exts = win ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
			for (const dir of (process.env.PATH ?? "").split(win ? ";" : ":")) {
				if (!dir) continue;
				for (const ext of exts) {
					try {
						if (statSync(join(dir, bin + ext)).isFile()) {
							ok = true;
							break;
						}
					} catch {
						/* not this dir */
					}
				}
				if (ok) break;
			}
		}
	} catch {
		ok = false;
	}
	commandCache.set(bin, ok);
	return ok;
}

function codegraphReady(cfg) {
	return commandAvailable(codegraphBin(cfg));
}

function runCodegraph(cfg, args) {
	const bin = codegraphBin(cfg);
	const cmd = [bin, ...args.map(shellSafe)].join(" ");
	return spawnSync(cmd, {
		shell: true,
		cwd: cfg.project_root ?? process.cwd(),
		encoding: "utf8",
		timeout: 120_000,
		maxBuffer: 64 * 1024 * 1024,
	});
}

// ─── telemetry helper ───

function record(rt, ev) {
	rt.telemetry?.record({ surface: "mcp", ...ev });
}

// ─── status semantics (spec 6 red line 3: an empty answer states why) ───

function statusText(status, detail) {
	return `[contextmind] status=${status} ${detail}`.trim();
}

const ADAPTER_MISSING_MAX = 120; // spec 11.2: sessionStart-scale warning budget

// ─── tool specs (schema) ───

export function toolSpecs() {
	return [
		{
			name: "context_orient",
			description:
				"First orientation in a repo area: relevant symbols, source excerpts and call paths from the CodeGraph index. " +
				"Use before reading files. Query should be a qualified name or pattern like 'OrderServiceImpl' or 'com/foo/Bar.java', not a short verb.",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "FQCN, *.java path pattern, or symbol name" },
				},
				required: ["query"],
			},
		},
		{
			name: "context_find",
			description:
				"Find symbols by name across the repo. Returns ranked matches with file:line. " +
				"For a symbol's source and call trail use context_orient; for task-scoped evidence use context_get.",
			inputSchema: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Symbol name or prefix to search" },
				},
				required: ["symbol"],
			},
		},
		{
			name: "context_get",
			description:
				"Assemble bounded evidence for a task within a token budget: reads the head of each anchor file (or the git-changed files when no anchors are given), " +
				"with per-file provenance and an omitted count. Pass anchors as project-relative file paths.",
			inputSchema: {
				type: "object",
				properties: {
					task: { type: "string", description: "One-line description of what you need the evidence for" },
					anchors: {
						type: "array",
						items: { type: "string" },
						description: "Project-relative file paths to include",
					},
					budget_tokens: { type: "number", description: "Output budget (default 1600, max 8000)" },
				},
				required: ["task"],
			},
		},
		{
			name: "context_impact",
			description:
				"Blast radius of changing a symbol: impact analysis plus callers/callees from the repo graph.",
			inputSchema: {
				type: "object",
				properties: {
					symbol: { type: "string", description: "Fully qualified or unique symbol name" },
				},
				required: ["symbol"],
			},
		},
		{
			name: "context_run",
			description:
				"Run a shell command in the project with governed output: exit code, key evidence and a handle for the raw payload. " +
				"Test/build failures keep their stack traces and counts. Use this instead of raw shell for anything with large output.",
			inputSchema: {
				type: "object",
				properties: {
					command: { type: "string", description: "Shell command to execute" },
					timeout_s: { type: "number", description: "Timeout in seconds (default 60, max 600)" },
				},
				required: ["command"],
			},
		},
		{
			name: "context_fetch",
			description:
				"Retrieve raw or partial evidence behind a handle created by the other tools. " +
				"Selectors: {start,end} lines, {pattern,flags} regex, {jsonPath}, {offset,page} chars.",
			inputSchema: {
				type: "object",
				properties: {
					handle: { type: "string", description: "Handle id, e.g. h_abc12345" },
					selector: { type: "object", description: "Optional selector; without it returns the raw payload" },
				},
				required: ["handle"],
			},
		},
	];
}

// ─── handlers ───

function gateText(rt, { raw, cmd, toolName, surface, exitCode }) {
	const res = rt.gate({ raw, cmd, toolName, surface, exitCode, source: cmd });
	record(rt, {
		toolName,
		contentType: res.contentType,
		success: exitCode === null || exitCode === 0,
		rawTokens: res.rawTokens,
		emittedTokens: res.emittedTokens,
		handleId: res.handleId,
		handleCreated: res.handleId ? 1 : 0,
		dedupHit: res.dedupHit,
		firstLayer: res.method,
		gateLatencyMs: res.latencyMs,
		adapterUsed: cmd,
	});
	return res;
}

async function toolOrient(args, rt) {
	const query = String(args?.query ?? "").trim();
	if (!query) return { content: [{ type: "text", text: "query is required" }], isError: true };
	const cfg = rt.cfg;
	if (cfg.adapters?.codegraph?.enabled === false) {
		return { content: [{ type: "text", text: statusText("ADAPTER_DISABLED", "codegraph disabled in config") }] };
	}
	if (!codegraphReady(cfg)) {
		record(rt, { toolName: "context_orient", adapterMissing: "codegraph" });
		const text = statusText(
			"ADAPTER_MISSING",
			"codegraph CLI unavailable; fall back to Grep/Read with bounded ranges.",
		);
		return { content: [{ type: "text", text }] };
	}
	const res = runCodegraph(cfg, ["explore", query]);
	const raw = `${res.stdout ?? ""}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}`;
	const gate = gateText(rt, {
		raw,
		cmd: `codegraph explore ${query}`,
		toolName: "context_orient",
		surface: "orient",
		exitCode: res.status,
	});
	return { content: [{ type: "text", text: `exit_code=${res.status}\n${gate.text}` }] };
}

async function toolFind(args, rt) {
	const symbol = String(args?.symbol ?? "").trim();
	if (!symbol) return { content: [{ type: "text", text: "symbol is required" }], isError: true };
	const cfg = rt.cfg;
	if (!codegraphReady(cfg)) {
		record(rt, { toolName: "context_find", adapterMissing: "codegraph" });
		const text = statusText(
			"ADAPTER_MISSING",
			"codegraph CLI unavailable; fall back to Grep with bounded output.",
		);
		return { content: [{ type: "text", text }] };
	}
	const res = runCodegraph(cfg, ["query", symbol]);
	const raw = `${res.stdout ?? ""}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}`.trim();
	if (!raw || /^(no|empty|0)/i.test(raw.split("\n")[0] ?? "")) {
		record(rt, { toolName: "context_find", success: true, rawTokens: countTokens(raw), emittedTokens: countTokens(raw), adapterUsed: "codegraph query" });
		return {
			content: [{
				type: "text",
				text: statusText("NO_MATCH", `no symbol matched "${symbol}"; try context_orient or a longer name.`),
			}],
		};
	}
	const gate = gateText(rt, {
		raw,
		cmd: `codegraph query ${symbol}`,
		toolName: "context_find",
		surface: "find",
		exitCode: res.status,
	});
	return { content: [{ type: "text", text: `exit_code=${res.status}\n${gate.text}` }] };
}

function inProject(cfg, path) {
	const root = resolve(cfg.project_root ?? process.cwd());
	const abs = resolve(root, path);
	const rel = relative(root, abs);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? abs : null;
}

function gitChangedFiles(cfg) {
	const out = new Set();
	for (const spec of ["HEAD", "--cached"]) {
		const res = spawnSync(`git diff --name-only ${spec}`, {
			shell: true,
			cwd: cfg.project_root ?? process.cwd(),
			encoding: "utf8",
			timeout: 10_000,
		});
		for (const line of (res.stdout ?? "").split("\n")) {
			if (line.trim()) out.add(line.trim());
		}
	}
	return [...out];
}

async function toolGet(args, rt) {
	const cfg = rt.cfg;
	const task = String(args?.task ?? "").trim();
	if (!task) return { content: [{ type: "text", text: "task is required" }], isError: true };
	const budget = Math.min(8000, Math.max(200, Number(args?.budget_tokens ?? cfg.budget.get)));
	const anchors = Array.isArray(args?.anchors) ? args.anchors : [];

	let candidates = [];
	for (const a of anchors) {
		const abs = inProject(cfg, String(a));
		if (!abs) {
			return {
				content: [{ type: "text", text: `anchor escapes project root: ${String(a)}` }],
				isError: true,
			};
		}
		try {
			if (statSync(abs).isFile()) candidates.push(abs);
		} catch {
			return { content: [{ type: "text", text: `anchor not found: ${String(a)}` }], isError: true };
		}
	}
	if (candidates.length === 0) {
		const changed = gitChangedFiles(cfg)
			.map((f) => inProject(cfg, f))
			.filter((f) => {
				try {
					return f && statSync(f).isFile();
				} catch {
					return false;
				}
			});
		candidates = changed.slice(0, 8);
	}

	if (candidates.length === 0) {
		record(rt, { toolName: "context_get", success: true, rawTokens: 0, emittedTokens: 0 });
		return {
			content: [{
				type: "text",
				text: statusText(
					"NO_CANDIDATES",
					"no anchors given and no changed files; pass anchors:[project-relative paths].",
				),
			}],
		};
	}

	const root = resolve(cfg.project_root ?? process.cwd());
	const blocks = [];
	const provenance = [];
	let omitted = 0;
	let rawTotal = 0;
	let used = 80; // footer allowance
	for (const abs of candidates) {
		const rel = relative(root, abs).replaceAll("\\", "/");
		let content;
		let mtime;
		try {
			content = readFileSync(abs, "utf8");
			mtime = statSync(abs).mtime.toISOString();
		} catch {
			omitted++;
			continue;
		}
		rawTotal += countTokens(content);
		const remaining = budget - used;
		const left = candidates.length - blocks.length;
		const share = Math.max(150, Math.floor(remaining / Math.max(1, left)));
		const slice = countTokens(content) <= share ? content : truncateToTokens(content, share);
		const totalLines = content.split("\n").length;
		const keptLines = slice.split("\n").length;
		const truncated = keptLines < totalLines;
		if (truncated) omitted++;
		blocks.push(`### ${rel} (lines 1-${keptLines} of ${totalLines}, mtime ${mtime})\n${slice}`);
		provenance.push(rel);
		used += countTokens(slice) + 20;
		if (budget - used < 150) {
			omitted += candidates.length - blocks.length;
			break;
		}
	}

	const body = blocks.join("\n\n");
	const footer =
		`\n[contextmind] task="${task.slice(0, 80)}" budget=${budget} tok packed=${provenance.length} ` +
		`files omitted=${omitted}; raise budget_tokens or narrow anchors for more.`;
	const text = `${body}\n${footer}`;
	record(rt, {
		toolName: "context_get",
		success: true,
		rawTokens: rawTotal,
		emittedTokens: countTokens(text),
		note: `packed ${provenance.length} files`,
	});
	return { content: [{ type: "text", text }] };
}

async function toolImpact(args, rt) {
	const symbol = String(args?.symbol ?? "").trim();
	if (!symbol) return { content: [{ type: "text", text: "symbol is required" }], isError: true };
	const cfg = rt.cfg;
	if (!codegraphReady(cfg)) {
		record(rt, { toolName: "context_impact", adapterMissing: "codegraph" });
		return {
			content: [{
				type: "text",
				text: statusText("ADAPTER_MISSING", "codegraph CLI unavailable; impact analysis needs the repo graph."),
			}],
		};
	}
	const res = runCodegraph(cfg, ["impact", symbol]);
	const noIndex = /not initialized|no index|run.*init/i.test(`${res.stdout ?? ""}${res.stderr ?? ""}`);
	if (noIndex || (res.status !== 0 && !res.stdout?.trim())) {
		record(rt, { toolName: "context_impact", success: false, adapterUsed: "codegraph impact", rawTokens: 0, emittedTokens: 0 });
		return {
			content: [{
				type: "text",
				text: statusText(
					"NO_INDEX",
					"codegraph index missing or symbol not found; run `codegraph init` in the project, then retry.",
				),
			}],
		};
	}
	// Impact plus the caller/callee trails: one tool call, one bounded answer.
	const extra = [];
	for (const sub of ["callers", "callees"]) {
		const r = runCodegraph(cfg, [sub, symbol]);
		if (r.status === 0 && r.stdout?.trim()) extra.push(`\n== ${sub} ==\n${r.stdout.trim()}`);
	}
	const raw = `${res.stdout ?? ""}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}${extra.join("\n")}`;
	const gate = gateText(rt, {
		raw,
		cmd: `codegraph impact ${symbol}`,
		toolName: "context_impact",
		surface: "impact",
		exitCode: res.status,
	});
	return { content: [{ type: "text", text: `exit_code=${res.status}\n${gate.text}` }] };
}

async function toolRun(args, rt) {
	const command = String(args?.command ?? "").trim();
	if (!command) return { content: [{ type: "text", text: "command is required" }], isError: true };
	const timeoutS = Math.min(600, Math.max(1, Number(args?.timeout_s ?? 60)));
	const res = spawnSync(command, {
		shell: true,
		cwd: rt.cfg.project_root ?? process.cwd(),
		encoding: "utf8",
		timeout: timeoutS * 1000,
		maxBuffer: 64 * 1024 * 1024,
	});
	const exitCode = res.error ? -1 : (res.status ?? -1);
	const raw = `${res.stdout ?? ""}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}`.trimEnd();
	const gate = gateText(rt, {
		raw: raw || "(no output)",
		cmd: command,
		toolName: "context_run",
		surface: "shell",
		exitCode,
	});
	return { content: [{ type: "text", text: `exit_code=${exitCode}\n${gate.text}` }] };
}

async function toolFetch(args, rt) {
	const handle = String(args?.handle ?? "").trim();
	if (!handle) return { content: [{ type: "text", text: "handle is required" }], isError: true };
	const selector = args?.selector && typeof args.selector === "object" ? args.selector : undefined;
	const result = rt.handles.fetch(handle, selector ?? {});
	if (result === null) {
		record(rt, { toolName: "context_fetch", success: false, rawTokens: 0, emittedTokens: 0, handleId: handle });
		return { content: [{ type: "text", text: `unknown or expired handle: ${handle}` }], isError: true };
	}
	record(rt, {
		toolName: "context_fetch",
		success: true,
		rawTokens: result.rawTokens,
		emittedTokens: result.tokens,
		handleId: handle,
		handleFetched: 1,
		note: `selector=${result.kind}`,
	});
	return { content: [{ type: "text", text: result.text }] };
}

const HANDLERS = {
	context_orient: toolOrient,
	context_find: toolFind,
	context_get: toolGet,
	context_impact: toolImpact,
	context_run: toolRun,
	context_fetch: toolFetch,
};

/**
 * Dispatch one tools/call. `rt` is the openRuntime() result. Never throws:
 * a failed dispatch is an MCP error result, not a crashed server.
 */
export async function callTool(name, args, rt) {
	const handler = HANDLERS[name];
	if (!handler) {
		return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
	}
	try {
		return await handler(args ?? {}, rt);
	} catch (err) {
		return {
			content: [{ type: "text", text: `${name} failed: ${err instanceof Error ? err.message : String(err)}` }],
			isError: true,
		};
	}
}
