#!/usr/bin/env node
/**
 * ContextMind CLI (spec 27).
 *
 *   contextmind install [dir]     install hooks + library into a Cursor project
 *   contextmind uninstall [dir]   remove exactly what install added
 *   contextmind doctor [dir]      PASS/WARN/FAIL for every subsystem
 *   contextmind status [dir]      where things live and how big they are
 *   contextmind report            three-column token ledger
 *   contextmind gc                prune telemetry, expire handles
 *   contextmind fetch <handle>    retrieve governed evidence
 *   contextmind config            show / validate the resolved config
 *   contextmind benchmark         measure the Output Gate over bench fixtures
 *
 * There is deliberately no `start` / `stop`. The architecture in spec 7 has a
 * daemon and a Rust hook bridge; neither exists in this slice because neither
 * has been shown necessary — hooks are stateless subprocesses and the latency
 * budget has not been missed (see docs/reports/SLICE_REPORT.md). Adding the
 * commands before the daemon would be two lie-sized placeholders.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULTS, ENGINE_ROOT, REPO_ROOT, configPaths, loadConfig, validateConfig } from "./lib/config.mjs";
import {
	HOOK_ENTRIES,
	HOOK_FILES,
	LEGACY_HOOK_RE,
	MANIFEST_NAME,
	MANIFEST_VERSION,
	commandFor,
	isOwnHook,
	launcherFor,
} from "./lib/install-plan.mjs";
import { engineStatus } from "./lib/engine.mjs";
import { openHandles } from "./lib/handles.mjs";
import { defaultDbPath as defaultTelemetryPath, formatSummary, openTelemetry } from "./lib/telemetry.mjs";
import { probeAdapters } from "./lib/probe.mjs";
import { countTokens, TOKENIZER_ID } from "./lib/tokens.mjs";
import { runOutputGate } from "./lib/output-gate.mjs";
import { Dedup } from "./lib/dedup.mjs";
import { classify } from "./lib/classify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS_SRC = join(REPO_ROOT, "cursor", "hooks");
const ASSETS_SRC = join(REPO_ROOT, "cursor");

// ─── helpers ───

function readJson(path, fallback = null) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Copy `path` to `path + suffix` once. The first backup is the pristine one. */
function backupOnce(path, suffix) {
	const target = `${path}${suffix}`;
	if (!existsSync(path) || existsSync(target)) return target;
	copyFileSync(path, target);
	return target;
}

// ─── install ───

function install(projectRoot, flags = {}) {
	const cursorDir = join(projectRoot, ".cursor");
	mkdirSync(cursorDir, { recursive: true });

	const hooksJson = join(cursorDir, "hooks.json");
	const backup = backupOnce(hooksJson, ".contextmind-backup");

	// Library.
	const libDest = join(cursorDir, "contextmind");
	rmSync(libDest, { recursive: true, force: true });
	cpSync(HERE, libDest, {
		recursive: true,
		filter: (src) => !src.includes(`${"node_modules"}`) && !src.endsWith(".db"),
	});

	// Hooks.
	const hooksDest = join(cursorDir, "hooks");
	mkdirSync(hooksDest, { recursive: true });
	const written = [];
	for (const file of HOOK_FILES) {
		copyFileSync(join(HOOKS_SRC, file), join(hooksDest, file));
		written.push(join(".cursor", "hooks", file));
		writeFileSync(join(hooksDest, file.replace(/\.mjs$/, ".cmd")), launcherFor(file.replace(/\.mjs$/, "")));
		written.push(join(".cursor", "hooks", file.replace(/\.mjs$/, ".cmd")));
	}

	// hooks.json merge.
	const existing = readJson(hooksJson, { version: 1, hooks: {} }) ?? { version: 1, hooks: {} };
	existing.version = 1;
	existing.hooks = existing.hooks ?? {};
	const retired = new Set();

	// Group by event first. Filtering inside the entry loop was a real bug: two
	// entries sharing an event (preToolUse has Read/Grep/Glob/Shell and Task)
	// each swept the other's freshly-added entry out of the list, and the
	// installed hooks.json silently lost Read and Shell governance — which is
	// most of the point of the slice. Grouping means the user's entries are
	// filtered exactly once per event.
	const byEvent = new Map();
	for (const entry of HOOK_ENTRIES) {
		const list = byEvent.get(entry.event) ?? [];
		list.push(entry);
		byEvent.set(entry.event, list);
	}

	for (const [event, entries] of byEvent) {
		const list = existing.hooks[event] ?? [];
		const kept = list.filter((h) => {
			if (isOwnHook(h)) return false;
			if (LEGACY_HOOK_RE.test(String(h?.command ?? ""))) {
				retired.add(String(h.command));
				return false;
			}
			return true;
		});
		for (const entry of entries) {
			kept.push({
				command: commandFor(entry.hook),
				...(entry.matcher ? { matcher: entry.matcher } : {}),
				failClosed: entry.failClosed,
			});
		}
		existing.hooks[event] = kept;
	}
	writeJson(hooksJson, existing);

	// Rules, skills, agents. Skills live in their own directories, so the copy
	// has to follow the tree rather than assume a flat file list.
	//
	// Rules are opt-in on purpose: the always rule is a standing token tax, and
	// a project that already carries its own L0 rule would go over budget the
	// moment we added ours. `install --rules` says the caller made that call.
	const assetDirs = flags.rules ? ["rules", "skills", "agents"] : ["skills", "agents"];
	const dirs = [];
	for (const dir of assetDirs) {
		const src = join(ASSETS_SRC, dir);
		if (!existsSync(src)) continue;
		const dest = join(cursorDir, dir);
		for (const entry of readdirSafe(src)) {
			const from = join(src, entry);
			const to = join(dest, entry);
			// A file the project already owns is left alone; only ContextMind's
			// own assets are ever overwritten, so reinstall picks up fixes.
			if (existsSync(to) && !entry.startsWith("contextmind")) continue;
			if (statSync(from).isDirectory()) {
				cpSync(from, to, { recursive: true, force: true });
				dirs.push(join(".cursor", dir, entry));
				written.push(...listFiles(from).map((f) => join(".cursor", dir, entry, f)));
			} else {
				mkdirSync(dest, { recursive: true });
				copyFileSync(from, to);
				written.push(join(".cursor", dir, entry));
			}
		}
	}

	// MCP server registration (S4, decision 5C): the six-tool surface is the
	// only ContextMind entry in mcp.json. Other servers the user configured
	// stay — removing them is a call for the owner, not the installer; doctor
	// reports the schema tax of anything still visible.
	const mcpJson = join(cursorDir, "mcp.json");
	backupOnce(mcpJson, ".contextmind-mcp-backup");
	const mcp = readJson(mcpJson, { mcpServers: {} }) ?? { mcpServers: {} };
	if (!mcp.mcpServers || typeof mcp.mcpServers !== "object") mcp.mcpServers = {};
	mcp.mcpServers.contextmind = {
		type: "stdio",
		command: process.execPath,
		args: [join(cursorDir, "contextmind", "mcp-server.mjs")],
		env: { CONTEXTMIND_PROJECT_DIR: resolve(projectRoot) },
	};
	writeJson(mcpJson, mcp);

	writeJson(join(cursorDir, MANIFEST_NAME), {
		manifest_version: MANIFEST_VERSION,
		installed_at: new Date().toISOString(),
		source_repo: REPO_ROOT,
		lib_dir: ".cursor/contextmind",
		files: written,
		dirs,
		retired_hooks: [...retired],
		hook_events: [...new Set(HOOK_ENTRIES.map((e) => e.event))],
		backup: existsSync(backup) ? backup : null,
	});

	console.log(`ContextMind installed into ${projectRoot}`);
	console.log(`  hooks:    ${HOOK_FILES.length} files -> .cursor/hooks/`);
	console.log(`  library:  .cursor/contextmind/`);
	console.log(`  events:   ${[...new Set(HOOK_ENTRIES.map((e) => e.event))].join(", ")}`);
	if (retired.size > 0) console.log(`  retired:  ${[...retired].join(", ")} (still in the backup)`);
	if (!flags.rules) console.log("  rules:    not copied (pass --rules to add the always rule)");
	if (existsSync(backup)) console.log(`  backup:   ${backup}`);
	return 0;
}

function readdirSafe(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** Relative paths of every file under `dir`, for uninstall bookkeeping. */
function listFiles(dir, prefix = "") {
	const out = [];
	for (const entry of readdirSafe(dir)) {
		const full = join(dir, entry);
		const rel = prefix ? join(prefix, entry) : entry;
		if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
		else out.push(rel);
	}
	return out;
}

// ─── uninstall ───

function uninstall(projectRoot) {
	const cursorDir = join(projectRoot, ".cursor");
	const manifest = readJson(join(cursorDir, MANIFEST_NAME));
	if (!manifest) {
		console.error(`No ${MANIFEST_NAME} in ${cursorDir} — nothing to uninstall.`);
		return 1;
	}

	for (const rel of manifest.files ?? []) {
		rmSync(join(projectRoot, rel), { force: true });
	}
	rmSync(join(cursorDir, "contextmind"), { recursive: true, force: true });
	// Directories are removed after their files; a skill dir left behind empty
	// still shows up in Cursor's skill list.
	for (const rel of manifest.dirs ?? []) rmSync(join(projectRoot, rel), { recursive: true, force: true });

	// Strip only our hook entries; anything else the user configured stays.
	const hooksJson = join(cursorDir, "hooks.json");
	const existing = readJson(hooksJson);
	if (existing?.hooks) {
		for (const [event, list] of Object.entries(existing.hooks)) {
			const kept = (list ?? []).filter((h) => !isOwnHook(h));
			if (kept.length > 0) existing.hooks[event] = kept;
			else delete existing.hooks[event];
		}
		writeJson(hooksJson, existing);
	}

	// Strip only our mcp.json entry; the file itself and other servers stay.
	const mcpJson = join(cursorDir, "mcp.json");
	const mcp = readJson(mcpJson);
	if (mcp?.mcpServers?.contextmind) {
		delete mcp.mcpServers.contextmind;
		if (Object.keys(mcp.mcpServers).length === 0) delete mcp.mcpServers;
		writeJson(mcpJson, mcp);
	}

	rmSync(join(cursorDir, MANIFEST_NAME), { force: true });
	console.log(`ContextMind removed from ${projectRoot}`);
	console.log("  handle/telemetry databases left in place; delete .contextmind/ to drop them too.");
	return 0;
}

// ─── doctor ───

function check(label, fn) {
	try {
		return { label, ...fn() };
	} catch (err) {
		return { label, status: "FAIL", detail: err instanceof Error ? err.message : String(err) };
	}
}

function doctor(projectRoot) {
	const cfg = loadConfig(projectRoot);
	const rows = [];

	rows.push(
		check("node runtime", () => {
			const major = Number(process.versions.node.split(".")[0]);
			return major >= 22
				? { status: "PASS", detail: `v${process.versions.node}` }
				: { status: "FAIL", detail: `v${process.versions.node} — need >=22.5 for node:sqlite` };
		}),
	);

	rows.push(
		check("engine (context-compress)", () => {
			const st = engineStatus();
			return st.ok ? { status: "PASS", detail: `${st.version} @ ${st.cli}` } : { status: "FAIL", detail: st.reason };
		}),
	);

	rows.push(
		check("config", () => {
			const paths = configPaths(projectRoot);
			const problems = [];
			for (const p of [paths.user, paths.project]) {
				const raw = readJson(p);
				if (raw && !validateConfig(raw, p)) problems.push(p);
			}
			return problems.length === 0
				? { status: "PASS", detail: `shell.first_layer=${cfg.shell.first_layer}` }
				: { status: "FAIL", detail: `invalid: ${problems.join(", ")}` };
		}),
	);

	rows.push(
		check("hooks installed", () => {
			const hooksJson = readJson(join(projectRoot, ".cursor", "hooks.json"));
			if (!hooksJson?.hooks) return { status: "WARN", detail: "no .cursor/hooks.json" };
			const missing = [];
			for (const entry of HOOK_ENTRIES) {
				const list = hooksJson.hooks[entry.event] ?? [];
				const present = list.some((h) => String(h?.command ?? "").includes(`hooks/${entry.hook}`));
				if (!present) missing.push(entry.event);
			}
			if (missing.length === HOOK_ENTRIES.length) return { status: "WARN", detail: "not installed (run: contextmind install)" };
			return missing.length === 0
				? { status: "PASS", detail: `${HOOK_ENTRIES.length} entries` }
				: { status: "FAIL", detail: `missing events: ${missing.join(", ")}` };
		}),
	);

	rows.push(
		check("hook scripts present", () => {
			const missing = HOOK_FILES.filter((f) => !existsSync(join(projectRoot, ".cursor", "hooks", f)));
			return missing.length === 0 ? { status: "PASS", detail: `${HOOK_FILES.length} files` } : { status: "FAIL", detail: `missing: ${missing.join(", ")}` };
		}),
	);

	rows.push(
		check("handle store", () => {
			const handles = openHandles(cfg);
			const ok = handles.available;
			const detail = ok ? `ok (${handles.stats()?.handles ?? 0} handles)` : handles.failed ?? "unavailable";
			handles.close();
			return ok ? { status: "PASS", detail } : { status: "FAIL", detail };
		}),
	);

	rows.push(
		check("telemetry db", () => {
			const t = openTelemetry(cfg);
			const ok = t.available;
			const detail = ok ? `ok (${t.summary()?.totals.events ?? 0} events)` : t.failed ?? "unavailable";
			t.close();
			return ok ? { status: "PASS", detail } : { status: "FAIL", detail };
		}),
	);

	rows.push(
		check("adapters", () => {
			const report = probeAdapters(cfg, projectRoot);
			if (report.missing.length === 0) return { status: "PASS", detail: report.declared.join(", ") || "none declared" };
			return { status: "WARN", detail: `not configured: ${report.missing.map((m) => m.name).join(", ")}` };
		}),
	);

	rows.push(
		check("always rules budget", () => {
			const rulesDir = join(projectRoot, ".cursor", "rules");
			if (!existsSync(rulesDir)) return { status: "WARN", detail: "no .cursor/rules" };
			let total = 0;
			let count = 0;
			for (const file of readdirSafe(rulesDir)) {
				if (!/\.(mdc|md)$/.test(file)) continue;
				const text = readFileSync(join(rulesDir, file), "utf8");
				// Only always-applied rules are a standing tax.
				if (!/alwaysApply:\s*true/i.test(text)) continue;
				total += countTokens(text);
				count++;
			}
			const cap = cfg.budget.always_rules;
			return total <= cap
				? { status: "PASS", detail: `${total}/${cap} tokens across ${count} rule(s)` }
				: { status: "FAIL", detail: `${total}/${cap} tokens across ${count} rule(s) — move detail into skills` };
		}),
	);

	rows.push(
		check("mcp server (six tools)", () => {
			const mcp = readJson(join(projectRoot, ".cursor", "mcp.json"));
			const servers = Object.keys(mcp?.mcpServers ?? {});
			const ours = mcp?.mcpServers?.contextmind;
			if (!ours) return { status: "WARN", detail: "not installed (run: contextmind install)" };
			const script = Array.isArray(ours.args) ? ours.args[0] : null;
			if (!script || !existsSync(script)) {
				return { status: "FAIL", detail: `server script missing: ${script}` };
			}
			const upstreams = servers.filter((s) => s !== "contextmind");
			// Spec 5.5: during the S1-S3 transition upstreams may coexist, but
			// doctor must report the schema tax instead of staying quiet.
			return upstreams.length === 0
				? { status: "PASS", detail: `6 tools @ ${script}` }
				: { status: "WARN", detail: `6 tools; upstreams still visible: ${upstreams.join(", ")}` };
		}),
	);

	let worst = "PASS";
	for (const row of rows) {
		if (row.status === "FAIL") worst = "FAIL";
		else if (row.status === "WARN" && worst === "PASS") worst = "WARN";
	}

	console.log(`ContextMind doctor — ${projectRoot}`);
	console.log("");
	for (const row of rows) console.log(`  ${row.status.padEnd(4)}  ${row.label.padEnd(28)} ${row.detail ?? ""}`);
	console.log("");
	console.log(`Verdict: ${worst}`);
	return worst === "FAIL" ? 1 : 0;
}

// ─── report / gc / fetch / status ───

function report(projectRoot, args) {
	const cfg = loadConfig(projectRoot);
	const t = openTelemetry(cfg);
	if (!t.available) {
		console.error(`telemetry unavailable: ${t.failed ?? "unknown"}`);
		return 1;
	}
	const since = args.since ?? null;
	const sessionId = args.session ?? null;
	const sum = t.summary({ since, sessionId });
	t.close();
	if (args.json) console.log(JSON.stringify(sum, null, 2));
	else console.log(formatSummary(sum, { title: `ContextMind ledger — ${projectRoot}` }));
	return 0;
}

function gc(projectRoot, args) {
	const cfg = loadConfig(projectRoot);
	const days = Number(args.days ?? 30);
	const t = openTelemetry(cfg);
	const events = t.available ? t.prune(days) : 0;
	t.close();
	const handles = openHandles(cfg);
	const dropped = handles.available ? handles.gc() : 0;
	const stats = handles.available ? handles.stats() : null;
	handles.close();
	console.log(`gc: removed ${events} telemetry event(s) older than ${days}d; expired ${dropped} handle(s)`);
	if (stats) console.log(`    handles remaining: ${stats.handles} (${(stats.bytes / 1024).toFixed(0)} KB, ${stats.raw_tokens} raw tokens)`);
	return 0;
}

function fetchHandle(projectRoot, handleId, args) {
	const cfg = loadConfig(projectRoot);
	const handles = openHandles(cfg);
	if (!handles.available) {
		console.error(`handle store unavailable: ${handles.failed ?? "unknown"}`);
		return 1;
	}
	const selector = {};
	if (args.jsonPath) selector.jsonPath = args.jsonPath;
	if (args.pattern) selector.pattern = args.pattern;
	if (args.lines) {
		const [start, end] = String(args.lines).split("-");
		selector.start = start;
		selector.end = end;
	}
	if (args.offset !== undefined) selector.offset = Number(args.offset);
	if (args.page) selector.page = Number(args.page);

	const result = handles.fetch(handleId, selector);
	if (!result) {
		handles.close();
		console.error(`handle ${handleId} not found or expired`);
		return 1;
	}
	const t = openTelemetry(cfg);
	if (t.available) {
		t.record({
			surface: "fetch",
			toolName: "fetch",
			handleId,
			handleFetched: 1,
			rawTokens: result.rawTokens,
			emittedTokens: result.tokens,
			toolEmittedSavings: 0,
			success: true,
			note: `kind:${result.kind}`,
		});
		t.close();
	}
	handles.close();
	process.stdout.write(`${result.text}\n`);
	return 0;
}

function status(projectRoot) {
	const cfg = loadConfig(projectRoot);
	const paths = configPaths(projectRoot);
	const t = openTelemetry(cfg);
	const h = openHandles(cfg);
	console.log(`project root : ${projectRoot}`);
	console.log(`user config  : ${paths.user}${existsSync(paths.user) ? "" : " (absent)"}`);
	console.log(`project cfg  : ${paths.project}${existsSync(paths.project) ? "" : " (absent)"}`);
	console.log(`telemetry db : ${cfg.telemetry.db ?? defaultTelemetryPath(projectRoot)}`);
	console.log(`first layer  : ${cfg.shell.first_layer} (locked)`);
	console.log(`tokenizer    : ${TOKENIZER_ID}`);
	console.log(`events       : ${t.available ? t.summary().totals.events : `unavailable (${t.failed})`}`);
	const stats = h.available ? h.stats() : null;
	console.log(`handles      : ${stats ? `${stats.handles} (${(stats.bytes / 1024).toFixed(0)} KB)` : `unavailable (${h.failed})`}`);
	t.close();
	h.close();
	return 0;
}

function configCmd(projectRoot, args) {
	const cfg = loadConfig(projectRoot);
	if (args.validate) {
		let bad = 0;
		for (const p of Object.values(configPaths(projectRoot))) {
			const raw = readJson(p);
			if (raw && !validateConfig(raw, p)) bad++;
		}
		console.log(bad === 0 ? "config validate: OK" : `config validate: ${bad} file(s) rejected`);
		return bad === 0 ? 0 : 1;
	}
	console.log(JSON.stringify(cfg, null, 2));
	return 0;
}

// ─── benchmark ───

function benchmark(projectRoot, args) {
	const fixturesDir = args.fixtures ?? join(REPO_ROOT, "bench", "fixtures");
	if (!existsSync(fixturesDir)) {
		console.error(`fixtures dir not found: ${fixturesDir}`);
		return 1;
	}
	const cfg = loadConfig(projectRoot);
	const handles = openHandles(cfg);
	const telemetry = openTelemetry(cfg);
	const dedup = new Dedup(handles.db, { enabled: false });

	const rows = [];
	for (const file of readdirSafe(fixturesDir)) {
		const path = join(fixturesDir, file);
		if (!statSync(path).isFile()) continue;
		const raw = readFileSync(path, "utf8");
		const cmd = /log|stacktrace|build/.test(file) ? "mvn test" : "git diff";
		const gated = runOutputGate({ raw, cmd, toolName: `fixture:${file}`, surface: "shell", cfg, handles, dedup, sessionId: `bench-${Date.now()}` });
		rows.push({
			file,
			type: gated.contentType,
			rawTokens: gated.rawTokens,
			emittedTokens: gated.emittedTokens,
			reduction: gated.rawTokens > 0 ? 1 - gated.emittedTokens / gated.rawTokens : 0,
			method: gated.method,
			abstained: gated.abstained,
			handle: gated.handleId,
		});
	}
	handles.close();
	telemetry.close();

	const overBudget = rows.filter((r) => r.rawTokens > 0);
	const totalRaw = overBudget.reduce((a, r) => a + r.rawTokens, 0);
	const totalEmitted = overBudget.reduce((a, r) => a + r.emittedTokens, 0);
	const pct = (v) => `${(v * 100).toFixed(1)}%`;

	console.log(`ContextMind Output Gate benchmark — ${new Date().toISOString()}`);
	console.log(`tokenizer: ${TOKENIZER_ID}   fixtures: ${fixturesDir}`);
	console.log("");
	console.log("| fixture | type | raw tok | emitted tok | reduction | method | abstained |");
	console.log("|---|---|---:|---:|---:|---|---|");
	for (const r of rows) {
		console.log(
			`| ${r.file} | ${r.type} | ${r.rawTokens} | ${r.emittedTokens} | ${pct(r.reduction)} | ${r.method} | ${r.abstained ? "yes" : "no"} |`,
		);
	}
	console.log("");
	console.log(
		`TOTAL raw=${totalRaw} emitted=${totalEmitted} reduction=${totalRaw > 0 ? pct(1 - totalEmitted / totalRaw) : "n/a"}`,
	);
	return 0;
}

// ─── dispatch ───

function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const [key, inline] = arg.slice(2).split("=");
		if (inline !== undefined) flags[key] = inline;
		else if (argv[i + 1] && !argv[i + 1].startsWith("--")) flags[key] = argv[++i];
		else flags[key] = true;
	}
	return { positional, flags };
}

const USAGE = `ContextMind CLI

  contextmind install [dir]        Install hooks and library into a Cursor project
  contextmind uninstall [dir]      Remove exactly what install added
  contextmind doctor [dir]         PASS/WARN/FAIL for every subsystem
  contextmind status [dir]         Paths, counts, locked settings
  contextmind report [--since ISO] [--session ID] [--json]
  contextmind gc [--days 30]       Prune telemetry, expire handles
  contextmind fetch <handle> [--lines a-b] [--pattern re] [--jsonPath p] [--offset n]
  contextmind config [--validate]
  contextmind benchmark [--fixtures DIR]

No \`start\` / \`stop\`: there is no daemon in this slice.`;

export function main(argv = process.argv.slice(2)) {
	const { positional, flags } = parseArgs(argv);
	const command = positional[0] ?? "help";
	const projectRoot = resolve(positional[1] ?? flags.dir ?? process.cwd());

	switch (command) {
		case "install":
			return install(projectRoot, flags);
		case "uninstall":
			return uninstall(projectRoot);
		case "doctor":
			return doctor(projectRoot);
		case "status":
			return status(projectRoot);
		case "report":
			return report(projectRoot, flags);
		case "gc":
			return gc(projectRoot, flags);
		case "fetch":
			if (!positional[1]) {
				console.error("usage: contextmind fetch <handle> [selector]");
				return 1;
			}
			return fetchHandle(projectRoot, positional[1], flags);
		case "config":
			return configCmd(projectRoot, flags);
		case "benchmark":
			return benchmark(projectRoot, flags);
		case "help":
		case "--help":
		case "-h":
			console.log(USAGE);
			return 0;
		default:
			console.error(`unknown command: ${command}\n\n${USAGE}`);
			return 1;
	}
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.mjs")) {
	process.exit(main());
}

export { DEFAULTS, ENGINE_ROOT, classify };
