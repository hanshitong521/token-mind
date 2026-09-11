/**
 * The seven MCP tools ContextMind exposes to the Agent (spec 9, decision 5C).
 *
 * Everything upstream is an internal adapter: CodeGraph through its local CLI
 * (probed at call time — a missing binary is a status, never a fake success),
 * the compression engine through the Output Gate, raw evidence through the
 * handle store. Tool descriptions are written to a budget: the whole
 * tools/list payload must measure <= budget.mcp_schema_total tokens
 (2500), so every word here costs context on every turn.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { runCodegraphSync } from "./codegraph-spawn.mjs";
import { codegraphBin, commandAvailable } from "./bin-probe.mjs";
import { countTokens, truncateToTokens } from "./tokens.mjs";
import { codegraphSymbolArg, isSimpleOrientSymbol, normalizeOrientQuery, orientSeenKey } from "./orient-key.mjs";
import { adapterCacheKey } from "./result-cache.mjs";
import { filterNotable, scanSymbols, serializeOutline } from "./symbols.mjs";

export { normalizeOrientQuery, orientSeenKey };
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

// codegraphBin / commandAvailable live in ./bin-probe.mjs (shared with probe.mjs).

function codegraphReady(cfg) {
	return commandAvailable(codegraphBin(cfg));
}

function runCodegraph(cfg, args, opts) {
	return runCodegraphSync(cfg, args, opts);
}

function orientMode(cfg) {
	const m = String(cfg?.adapters?.codegraph?.orient_mode ?? "auto").toLowerCase();
	if (m === "explore" || m === "fast") return m;
	return "auto";
}

/** ~1–5s on large repos vs 60–120s for full explore; falls back when output is empty. */
function runOrientFast(cfg, query) {
	const sym = codegraphSymbolArg(query);
	if (!sym) return { ok: false, raw: "", sym: "" };
	const chunks = [];
	let worstExit = 0;
	const nodeRes = runCodegraph(cfg, ["node", sym], { timeoutMs: 25_000 });
	const nodeCode = nodeRes.status ?? 1;
	const nodeOut = `${nodeRes.stdout ?? ""}${nodeRes.stderr ? `\n[stderr]\n${nodeRes.stderr}` : ""}`.trim();
	chunks.push(`### codegraph node ${sym}\nexit_code=${nodeCode}\n${nodeOut}`);
	let raw = chunks.join("\n\n");
	let ok = nodeCode === 0 && nodeOut.length > 80;
	if (ok) {
		for (const [sub, subArgs] of [
			["callers", [sym, "--limit", "12"]],
			["callees", [sym, "--limit", "12"]],
		]) {
			const res = runCodegraph(cfg, [sub, ...subArgs], { timeoutMs: 20_000 });
			const code = res.status ?? 1;
			worstExit = Math.max(worstExit, code);
			const out = `${res.stdout ?? ""}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}`.trim();
			if (out) chunks.push(`### codegraph ${sub} ${sym}\nexit_code=${code}\n${out}`);
		}
		raw = chunks.join("\n\n");
	}
	return { ok, raw, sym };
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
					refresh: {
						type: "boolean",
						description: "Force re-orient; default false (same symbol blocked for this MCP process)",
					},
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
		{
			name: "context_outline",
			description:
				"Symbol outline (kind/name/line range) for one file; bounded first step before Read; no codegraph needed.",
			inputSchema: {
				type: "object",
				properties: {
					file: { type: "string", description: "Project-relative file path" },
					query: { type: "string", description: "Filter to symbols matching this substring" },
					include_body: { type: "boolean", description: "Attach bounded body slices; default false" },
					notable: { type: "boolean", description: "Drop private helpers and accessor boilerplate" },
					engine: { type: "string", enum: ["builtin", "serena"], description: "Default builtin (zero-dependency)" },
				},
				required: ["file"],
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
	const refresh = args?.refresh === true;
	const okey = orientSeenKey(query);
	const sessionId = rt.sessionId ?? "mcp-server";
	const cacheKey = adapterCacheKey("context_orient", query);

	// 1) Same MCP process — ORIENT_DUP stub (cheapest).
	if (okey && !refresh) {
		const prev = rt.seen?.lookup(sessionId, "orient", okey);
		if (prev) {
			const skip = cfg.cache_engine?.orientSkipTokensEstimate ?? 364;
			record(rt, {
				toolName: "context_orient",
				success: false,
				note: "orient_dup",
				preventedReadTokens: skip,
				emittedTokens: 40,
				rawTokens: 0,
			});
			const handleHint = prev.handle_id ? ` Prior handle=${prev.handle_id}.` : "";
			return {
				content: [{
					type: "text",
					text: statusText(
						"ORIENT_DUP",
						`Same symbol already oriented this MCP process (${prev.hits}×, key=${okey}).${handleHint} Use context_fetch with a line selector. Pass refresh=true only if the graph changed.`,
					),
				}],
			};
		}
	}

	// 2) Cross-process / cross-session — ResultCache (skip codegraph spawn).
	if (!refresh && rt.cache) {
		const hit = rt.cache.lookup(cacheKey);
		if (hit?.source) {
			const emitted = countTokens(hit.source);
			record(rt, {
				toolName: "context_orient",
				success: true,
				note: "orient_cache_hit",
				handleId: hit.handleId,
				handleCreated: 0,
				rawTokens: hit.rawTokens ?? 0,
				emittedTokens: emitted,
				adapterUsed: "result_cache",
				preventedReadTokens: cfg.cache_engine?.orientSkipTokensEstimate ?? 364,
			});
			if (okey) rt.seen?.touch(sessionId, "orient", okey, hit.handleId ?? null);
			return {
				content: [{
					type: "text",
					text: `exit_code=0 explore_ms=0 cache=hit hits=${hit.hits ?? 1}\n${hit.source}`,
				}],
			};
		}
	}

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
	const mode = orientMode(cfg);
	const tryFast = mode === "fast" || (mode === "auto" && isSimpleOrientSymbol(query));
	let exploreMs = 0;
	let orientPath = "explore";
	let exitCode = 0;
	let raw = "";
	if (tryFast) {
		const tFast = performance.now();
		const fast = runOrientFast(cfg, query);
		exploreMs = Math.round(performance.now() - tFast);
		if (fast.ok) {
			orientPath = "fast";
			raw = fast.raw;
		}
	}
	if (!raw) {
		const t0 = performance.now();
		const res = runCodegraph(cfg, ["explore", query]);
		exploreMs = Math.round(performance.now() - t0);
		orientPath = "explore";
		exitCode = res.status ?? 1;
		raw = `${res.stdout ?? ""}${res.stderr ? `\n[stderr]\n${res.stderr}` : ""}`;
	}
	// Cap before Output Gate — huge explore dumps dominate wall time.
	const MAX_ORIENT_RAW_CHARS = 120_000;
	if (raw.length > MAX_ORIENT_RAW_CHARS) {
		raw = `${raw.slice(0, MAX_ORIENT_RAW_CHARS)}\n…[orient raw truncated ${raw.length - MAX_ORIENT_RAW_CHARS} chars for gate]`;
	}
	const gate = gateText(rt, {
		raw,
		cmd: `codegraph ${orientPath} ${query}`,
		toolName: "context_orient",
		surface: "orient",
		exitCode,
	});
	const body = `exit_code=${exitCode} orient_path=${orientPath} explore_ms=${exploreMs}\n${gate.text}`;
	if (okey) rt.seen?.touch(sessionId, "orient", okey, gate.handleId ?? null);
	rt.cache?.store(cacheKey, {
		handleId: gate.handleId ?? null,
		source: body,
		rawTokens: gate.rawTokens ?? 0,
	});
	return { content: [{ type: "text", text: body }] };
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
	// Ledger rule (S8, G-S8-01): an event may never show emitted > raw. For
	// tiny anchors the assembly overhead (headers + footer) can exceed the
	// counterfactual full read; that call saved nothing, so raw is recorded
	// as the emitted size rather than inventing a negative saving.
	const emitted = countTokens(text);
	record(rt, {
		toolName: "context_get",
		success: true,
		rawTokens: Math.max(rawTotal, emitted),
		emittedTokens: emitted,
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
	// Ledger rule (S8, G-S8-06): a fetch is what the model SPENT to pull
	// evidence back, not a second compression. raw = emitted = what was
	// actually returned; the original event's history is never rewritten.
	record(rt, {
		toolName: "context_fetch",
		success: true,
		rawTokens: result.tokens,
		emittedTokens: result.tokens,
		handleId: handle,
		handleFetched: 1,
		note: `selector=${result.kind}`,
	});
	return { content: [{ type: "text", text: result.text }] };
}

// ─── context_outline (spec: .trae/documents/integrate-serena-symbol-outline.md) ───

/**
 * Symbol-level outline — Serena's core lesson re-derived with zero runtime
 * dependencies: return the file's structure (kind + name_path + line range) so
 * the agent can locate a target line instead of reading the whole file.
 *
 * The counterfactual is the full read (`raw`); everything is measured against
 * it, and the ledger rule (raw >= emitted) is enforced before recording.
 */
async function toolOutline(args, rt) {
	const cfg = rt.cfg;
	const file = String(args?.file ?? "").trim();
	if (!file) return { content: [{ type: "text", text: "file is required" }], isError: true };

	const abs = inProject(cfg, file);
	if (!abs) {
		return {
			content: [{ type: "text", text: statusText("OUT_OF_BOUNDS", `path escapes project root: ${file}`) }],
			isError: true,
		};
	}

	let stat;
	try {
		stat = statSync(abs);
	} catch {
		return { content: [{ type: "text", text: statusText("NOT_FOUND", `no such file: ${file}`) }], isError: true };
	}
	if (!stat.isFile()) {
		return { content: [{ type: "text", text: statusText("NOT_FOUND", `not a regular file: ${file}`) }], isError: true };
	}

	// Return-side guard only: an oversized file is refused outright, never read
	// into the body path, so "just look at the structure" cannot blow the window.
	const outline = cfg.outline ?? {};
	const maxInputBytes = Number(outline.max_input_bytes ?? 1_048_576);
	if (stat.size > maxInputBytes) {
		return {
			content: [{
				type: "text",
				text: statusText("TOO_LARGE", `${stat.size} bytes > cap ${maxInputBytes}; use context_orient or Read with offset+limit.`),
			}],
			isError: true,
		};
	}

	let source;
	try {
		source = readFileSync(abs, "utf8");
	} catch (err) {
		return { content: [{ type: "text", text: statusText("READ_FAILED", String(err?.message ?? err)) }], isError: true };
	}

	const rel = relative(resolve(cfg.project_root ?? process.cwd()), abs).replaceAll("\\", "/");
	const rawTokens = countTokens(source);

	// Engine selection (spec §5): serena is an optional, default-off adapter.
	// When it is off the built-in scanner serves the call and the result shape
	// never changes — a missing enhancement degrades the engine label, not the tool.
	const engine =
		args?.engine === "serena" && cfg.adapters?.serena?.enabled === true ? "builtin(serena_unbridged)" : "builtin";

	const scan = scanSymbols(rel, source, { maxSymbols: Number(outline.max_symbols ?? 2000) });
	const symbols = args?.notable === true ? filterNotable(scan.symbols) : scan.symbols;
	const query = typeof args?.query === "string" ? args.query.trim() : "";
	const lineCount = source.split("\n").length;

	let text = `# ${rel} · ${engine} · s=${symbols.length} · L=${lineCount}\n${serializeOutline(symbols, source, {
		query,
		includeBody: args?.include_body === true,
	})}`;

	const maxTokens = Number(outline.max_tokens ?? 1600);
	const clipped = countTokens(text) > maxTokens;
	if (clipped) text = truncateToTokens(text, maxTokens);
	if (scan.truncated || clipped) {
		text += `\n[contextmind] truncated=${scan.truncated ? "symbols" : "tokens"}; narrow with query= or raise outline.max_tokens.`;
	}

	const emitted = countTokens(text);
	record(rt, {
		toolName: "context_outline",
		contentType: "outline",
		success: true,
		rawTokens: Math.max(rawTokens, emitted),
		emittedTokens: emitted,
		note: `${symbols.length} symbols${query ? ` query=${query}` : ""}${args?.notable === true ? " notable" : ""}`,
	});
	return { content: [{ type: "text", text }] };
}

const HANDLERS = {
	context_orient: toolOrient,
	context_find: toolFind,
	context_get: toolGet,
	context_impact: toolImpact,
	context_run: toolRun,
	context_fetch: toolFetch,
	context_outline: toolOutline,
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
		// Normalise the success flag: a caller reads `isError` to tell a payload
		// from a status, so every result states it explicitly rather than leaving
		// the absence of the field to mean success. A handler's own `isError`
		// wins, since it is spread last.
		return { isError: false, ...(await handler(args ?? {}, rt)) };
	} catch (err) {
		return {
			content: [{ type: "text", text: `${name} failed: ${err instanceof Error ? err.message : String(err)}` }],
			isError: true,
		};
	}
}
