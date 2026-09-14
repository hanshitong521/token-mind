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
 *   contextmind start             start TokenMind Runtime (localhost HTTP)
 *   contextmind stop              stop TokenMind Runtime
 */

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { DEFAULTS, ENGINE_ROOT, REPO_ROOT, resolveAssetsDir, resolveHooksDir, configPaths, loadConfig, validateConfig } from "./lib/config.mjs";
import {
	HOOK_ENTRIES,
	HOOK_FILES,
	HOOK_SCRIPT_DIR,
	LEGACY_HOOK_RE,
	MANIFEST_NAME,
	MANIFEST_VERSION,
	dedupeEntriesForHost,
	hookEntryPresent,
	hookEntryFor,
	isOwnHookEntry,
	launcherForNodeOnly,
	launcherForVerifiedNative,
} from "./lib/install-plan.mjs";
import { FORBIDDEN_STANDING_UPSTREAMS, lockUpstreams, unlockUpstreams } from "./lib/upstreams-lock.mjs";
import { hostProfiles, hookEventName, mcpConfigFile, resolveConfigFile, supports } from "./lib/hosts.mjs";
import { engineStatus } from "./lib/engine.mjs";
import { openHandles } from "./lib/handles.mjs";
import { defaultDbPath as defaultTelemetryPath, formatSummary, openTelemetry } from "./lib/telemetry.mjs";
import { probeCodegraphSpawn } from "./lib/codegraph-spawn.mjs";
import { probeAdapters } from "./lib/probe.mjs";
import { countTokens, TOKENIZER_ID } from "./lib/tokens.mjs";
import { runOutputGate } from "./lib/output-gate.mjs";
import {
	isListening,
	resolveRuntimePort,
	startDaemon,
	stopDaemon,
	runtimeHost,
	runtimePort,
} from "./lib/runtime/lifecycle.mjs";
import { Dedup } from "./lib/dedup.mjs";
import { classify } from "./lib/classify.mjs";
import { contextmindStdioEntry, repairMcpMounts } from "./lib/mcp-repair.mjs";
import { wrapNodeBin } from "./lib/shell-guard.mjs";
import { validateActiveTaskBundle } from "./lib/task-bundle.mjs";
import { projectScorecardView } from "./lib/stack-scorecard.mjs";
import { initAgentStateScaffold, syncAgentStateFromTaskBundle } from "./lib/agent-state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS_SRC = resolveHooksDir(HERE);
const ASSETS_SRC = resolveAssetsDir(HERE);

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

function parseHookStdout(stdout) {
	const raw = String(stdout ?? "").trim();
	if (!raw.startsWith("{")) return { ok: false, reason: "not_json", sample: raw.slice(0, 120) };
	try {
		JSON.parse(raw);
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: err.message, sample: raw.slice(0, 120) };
	}
}

function verifyCmhookJson(hooksDir) {
	const exe = join(hooksDir, "cmhook.exe");
	if (!existsSync(exe)) return { ok: false, reason: "no_cmhook_exe" };
	const cases = [
		["cm-pre-tool", { tool_name: "Shell", tool_input: { command: "echo ok" } }],
		["cm-pre-tool", { tool_name: "Shell", tool_input: { command: "git status -sb" } }],
		["cm-post-tool", { tool_name: "Shell", tool_output: "ok\n" }],
	];
	for (const [hook, partial] of cases) {
		const sampleInput = JSON.stringify({
			...partial,
			cwd: hooksDir,
			workspace_roots: [hooksDir],
		});
		const r = spawnSync(exe, [hook], {
			input: sampleInput,
			encoding: "utf8",
			timeout: 5_000,
			windowsHide: true,
		});
		if (r.status !== 0) return { ok: false, reason: `${hook}:exit_${r.status}` };
		const parsed = parseHookStdout(r.stdout);
		if (!parsed.ok) return { ok: false, reason: `${hook}:${parsed.reason}`, sample: parsed.sample };
	}
	return { ok: true };
}

/**
 * One binary serves every host, but the hosts do not agree on the egress envelope:
 * a Claude-shaped host ignores Cursor's `{permission}` object, so a native client that
 * only speaks Cursor's contract silently drops every deny there — governance looks
 * installed and does nothing. Prove the translation per host stamp before enabling it.
 */
function verifyCmhookEgress(hooksDir, profiles) {
	const exe = join(hooksDir, "cmhook.exe");
	if (!existsSync(exe)) return { ok: false, reason: "no_cmhook_exe" };
	const sampleInput = JSON.stringify({
		tool_name: "Shell",
		tool_input: { command: "echo ok" },
		cwd: hooksDir,
		workspace_roots: [hooksDir],
	});
	const seen = new Set();
	for (const profile of profiles) {
		const env = { ...(profile.hooks?.env ?? {}) };
		const nested = profile.hooks?.file?.entryShape === "claude-nested";
		const key = `${env.CONTEXTMIND_HOST ?? ""}|${nested}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const r = spawnSync(exe, ["cm-pre-tool"], {
			input: sampleInput,
			encoding: "utf8",
			timeout: 5_000,
			windowsHide: true,
			env: { ...process.env, ...env },
		});
		if (r.status !== 0) return { ok: false, reason: `${profile.id}:exit_${r.status}` };
		const out = String(r.stdout ?? "");
		if (nested && !out.includes("hookSpecificOutput")) {
			return { ok: false, reason: `${profile.id}:cursor_contract_only`, sample: out.slice(0, 120) };
		}
	}
	return { ok: true };
}

function applyCmhookLauncherPolicy(hooksDir, verifyResult) {
	const marker = join(hooksDir, ".cmhook-json-ok");
	const exe = join(hooksDir, "cmhook.exe");
	if (verifyResult.ok) {
		writeFileSync(marker, `${new Date().toISOString()}\n`);
		return { mode: "cmhook" };
	}
	try {
		if (existsSync(marker)) rmSync(marker, { force: true });
	} catch {
		/* ok */
	}
	const bak = `${exe}.disabled`;
	if (existsSync(exe)) {
		try {
			if (existsSync(bak)) rmSync(bak, { force: true });
			renameSync(exe, bak);
		} catch {
			/* ok */
		}
	}
	return { mode: "node-only", reason: verifyResult.reason };
}

/** Unblock Cursor when cmhook returns invalid JSON — node-only .cmd, disable native client. */
function fixHooks(projectRoot) {
	const hooksDest = join(projectRoot, ".cursor", "hooks");
	if (!existsSync(hooksDest)) {
		console.error(`no hooks dir: ${hooksDest}`);
		return 1;
	}
	applyCmhookLauncherPolicy(hooksDest, { ok: false, reason: "fix-hooks" });
	for (const file of HOOK_FILES) {
		if (file.endsWith(".mjs")) {
			writeFileSync(
				join(hooksDest, file.replace(/\.mjs$/, ".cmd")),
				launcherForNodeOnly(file.replace(/\.mjs$/, "")),
			);
		}
	}
	console.log(`fix-hooks: node-only launchers written under ${hooksDest}`);
	console.log("Reload the Cursor window, then: contextmind start && contextmind install [dir]");
	return 0;
}

/** Where a user-scope host keeps its settings; set by `install --home` for a dry run. */
function userHome() {
	return process.env.CONTEXTMIND_INSTALL_HOME || process.env.USERPROFILE || process.env.HOME || homedir();
}

/**
 * Write this host's hook entries into the file its own loader reads.
 *
 * Everything host-specific is data: which file (and whether it is project- or
 * user-scope), which key holds the hook list, which extra root fields the host
 * expects, what its events are spelled as, and what a row looks like. What is
 * left here is the merge, and it keeps two rules the Cursor install learned the
 * hard way — group by event before filtering, because two rows sharing an event
 * each sweep the other's fresh entry out of the list and the install silently
 * loses governance; and strip only our own entries, so a hook the user wrote by
 * hand survives a reinstall.
 */
function installHooksForHost(profile, { projectRoot, native = false } = {}) {
	const target = profile.hooks?.file;
	const file = resolveConfigFile(target, { projectRoot, home: userHome() });
	if (!file) return { host: profile.id, file: null, scope: null, entries: 0, backup: null, retired: [] };
	mkdirSync(dirname(file), { recursive: true });
	const backup = backupOnce(file, ".contextmind-backup");
	const doc = readJson(file, {}) ?? {};
	for (const [key, value] of Object.entries(target.rootFields ?? {})) doc[key] = value;

	const keyPath = target.keyPath || "hooks";
	if (!doc[keyPath] || typeof doc[keyPath] !== "object") doc[keyPath] = {};
	const hooksRoot = doc[keyPath];

	const retired = new Set();
	const grouped = new Map();
	for (const entry of dedupeEntriesForHost(profile, HOOK_ENTRIES)) {
		const list = grouped.get(entry.event) ?? [];
		list.push(entry);
		grouped.set(entry.event, list);
	}

	let written = 0;
	for (const [event, entries] of grouped) {
		const list = Array.isArray(hooksRoot[event]) ? hooksRoot[event] : [];
		const kept = list.filter((h) => {
			if (isOwnHookEntry(profile, h)) return false;
			if (LEGACY_HOOK_RE.test(String(h?.command ?? ""))) {
				retired.add(String(h.command));
				return false;
			}
			return true;
		});
		for (const entry of entries) {
			const row = hookEntryFor(profile, {
				hook: entry.hook,
				event,
				projectRoot,
				matcher: entry.matcher,
				failClosed: entry.failClosed,
				native,
			});
			if (!row) continue;
			kept.push(row);
			written += 1;
		}
		hooksRoot[event] = kept;
	}
	writeJson(file, doc);
	return {
		host: profile.id,
		file,
		scope: target.scope ?? "project",
		entries: written,
		backup: existsSync(backup) ? backup : null,
		retired: [...retired],
	};
}

/** True when the host keeps config somewhere on this box already (its dir exists). */
function hostPresent(profile, { projectRoot, home }) {
	const targets = [profile.mcp, profile.hooks?.file].filter((t) => t?.path);
	return targets.some((t) => {
		const file = resolveConfigFile(t, { projectRoot, home });
		return file && existsSync(dirname(file));
	});
}

/**
 * Which hosts this install may write to.
 *
 * A profile is a claim about a host's config paths, so writing one for a tool that
 * is not on this machine creates the file it describes (~/.codex/..., ~/.trae/...)
 * and teaches the next reader to trust a path nobody verified. Default is
 * therefore "verified AND its config directory already exists"; `--hosts=a,b`
 * overrides that for a deliberate install.
 */
function selectInstallHosts(flags, projectRoot) {
	// userHome(), not a second USERPROFILE read: the two must agree or `--home` /
	// CONTEXTMIND_INSTALL_HOME isolates the *write* while this scan still probes the
	// real home, selecting a user-scope host whose config it will then write to the
	// isolated one. That is how a test run reaches the developer's actual
	// ~/.workbuddy/connectors/<uid>/mcp.json.
	const home = userHome();
	const wanted =
		typeof flags.hosts === "string"
			? flags.hosts
					.split(",")
					.map((s) => s.trim().toLowerCase())
					.filter(Boolean)
			: null;
	return hostProfiles()
		.filter((h) => h.verified === true)
		.filter((h) => (wanted ? wanted.includes(h.id) : hostPresent(h, { projectRoot, home })));
}

/**
 * Register the MCP server wherever a host can see it.
 *
 * Two scopes exist because the hosts do: Cursor reads a project `.cursor/mcp.json`,
 * while Qoder only ever reads MCP servers out of the machine-wide
 * `~/.qoder-cn/settings.json`. A user-scope entry therefore pins
 * CONTEXTMIND_PROJECT_DIR to the project being installed — the same trade-off the
 * existing context-compress entry on this box already makes — and `doctor` reports
 * that pinning instead of pretending the registration is per-project.
 *
 * Unverified profiles are skipped with a reason: writing a guessed path produces a
 * server that is registered, visible and never correct.
 */
function registerMcpServers({ projectRoot, serverPath, hosts }) {
	const results = [];
	const projCfg = readJson(join(projectRoot, ".contextmind.json"));
	for (const profile of hosts.filter((h) => supports(h, "mcp"))) {
		if (profile.verified !== true) {
			results.push({
				host: profile.id,
				skipped: profile.unverifiedReason || "profile not verified against a real install",
			});
			continue;
		}
		const file = mcpConfigFile(profile.id, { projectRoot, home: userHome() });
		const keyPath = profile.mcp.keyPath || "mcpServers";
		const backup = backupOnce(file, ".contextmind-mcp-backup");
		const doc = readJson(file, {}) ?? {};
		if (!doc[keyPath] || typeof doc[keyPath] !== "object") doc[keyPath] = {};
		const env = { CONTEXTMIND_PROJECT_DIR: resolve(projectRoot) };
		if (projCfg?.cache_engine?.kvUrl) env.CONTEXTMIND_KV_BRIDGE_URL = String(projCfg.cache_engine.kvUrl);
		const prevEnv = doc[keyPath]?.contextmind?.env;
		if (prevEnv && typeof prevEnv === "object") {
			for (const [k, v] of Object.entries(prevEnv)) {
				if (v != null && env[k] === undefined) env[k] = v;
			}
		}
		doc[keyPath].contextmind = contextmindStdioEntry(
			projectRoot,
			serverPath,
			profile,
			projCfg,
			doc[keyPath]?.contextmind,
		);
		writeJson(file, doc);
		results.push({
			host: profile.id,
			file,
			scope: profile.mcp.scope,
			backup: existsSync(backup) ? backup : null,
		});
	}
	return results;
}

async function install(projectRoot, flags = {}) {
	const hosts = selectInstallHosts(flags, projectRoot);
	const cursorDir = join(projectRoot, ".cursor");
	mkdirSync(cursorDir, { recursive: true });

	// Library.
	const libDest = join(cursorDir, "contextmind");
	if (resolve(libDest) === resolve(HERE)) {
		console.error(
			"[contextmind install] refused in-place: would delete the library being executed. Run from SSOT: token-mind/contextmind/cli.mjs install <project>",
		);
		return 1;
	}
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
		if (file.endsWith(".mjs")) {
			writeFileSync(join(hooksDest, file.replace(/\.mjs$/, ".cmd")), launcherForNodeOnly(file.replace(/\.mjs$/, "")));
			written.push(join(".cursor", "hooks", file.replace(/\.mjs$/, ".cmd")));
		}
	}
	const cmhookSrc = join(HOOKS_SRC, "cmhook.exe");
	if (existsSync(cmhookSrc)) {
		copyFileSync(cmhookSrc, join(hooksDest, "cmhook.exe"));
		written.push(join(".cursor", "hooks", "cmhook.exe"));
	}

	let hookClientMode = "node-only";
	try {
		await startDaemon({ waitMs: 5_000, converge: true });
		const verify = verifyCmhookJson(hooksDest);
		// One binary serves every host, so a build that only speaks Cursor's contract must not
		// pass: it would silently no-op the decisions of each nested-shape host installed here.
		const verified = verify.ok ? verifyCmhookEgress(hooksDest, hosts.filter((h) => supports(h, "hooks"))) : verify;
		const policy = applyCmhookLauncherPolicy(hooksDest, verified);
		hookClientMode = policy.mode;
		const pickLauncher = verified.ok ? launcherForVerifiedNative : launcherForNodeOnly;
		for (const file of HOOK_FILES) {
			if (file.endsWith(".mjs")) {
				writeFileSync(
					join(hooksDest, file.replace(/\.mjs$/, ".cmd")),
					pickLauncher(file.replace(/\.mjs$/, "")),
				);
			}
		}
		if (!verified.ok) {
			console.warn(`[contextmind install] cmhook verify FAIL (${verified.reason}); using node thin client only`);
		} else {
			console.log("[contextmind install] cmhook verify PASS; native client enabled");
		}
	} catch (err) {
		console.warn(`[contextmind install] cmhook verify skipped: ${err?.message ?? err}`);
	}

	// One merge per host that has a hook surface. Which file, which event spelling and
	// which row shape are the profile's business; the grouping-by-event rule inside
	// installHooksForHost is what keeps a host with two preToolUse rows (Read/Grep/Glob/
	// Shell and Task) from sweeping its own fresh entries back out again.
	const hookInstalls = [];
	const retired = new Set();
	for (const profile of hosts.filter((h) => supports(h, "hooks"))) {
		const result = installHooksForHost(profile, {
			projectRoot,
			native: hookClientMode === "cmhook",
		});
		for (const cmd of result.retired) retired.add(cmd);
		hookInstalls.push(result);
	}

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

	// MCP server registration (S4, decision 5C), now for every host that has a
	// place to put it: the Cursor-only file is why the Qoder column of the ledger
	// could never hold a governed MCP call. ContextMind's entry is the only one
	// touched; other servers the user configured stay — removing them is a call
	// for the owner, not the installer.
	const mcpServers = registerMcpServers({
		projectRoot,
		serverPath: join(libDest, "mcp-server.mjs"),
		hosts,
	});

	// Quarantine raw upstreams (codegraph) out of the agent-visible catalogue:
	// leaving them registered duplicates the tool surface (schema tax) and lets
	// an agent bypass preToolUse when Cursor exposes MCP without hook coverage.
	// The entries are preserved in a lock file and restored by uninstall.
	const cursorMcp = mcpServers.find((r) => r.host === "cursor");
	const { quarantined, lockPath } = lockUpstreams(cursorMcp ? cursorMcp.file : join(cursorDir, "mcp.json"));

	writeJson(join(cursorDir, MANIFEST_NAME), {
		manifest_version: MANIFEST_VERSION,
		installed_at: new Date().toISOString(),
		source_repo: REPO_ROOT,
		lib_dir: ".cursor/contextmind",
		hosts_installed: hosts.map((h) => h.id),
		files: written,
		dirs,
		retired_hooks: [...retired],
		hook_events: [...new Set(HOOK_ENTRIES.map((e) => e.event))],
		// `hooks` rows are shared by every host — each hook script lives under
		// .cursor/hooks and reads its contract from CONTEXTMIND_HOST.
		hooks_scripts_dir: HOOK_SCRIPT_DIR,
		hooks_installs: hookInstalls,
		backup: hookInstalls.find((h) => h.host === "cursor")?.backup ?? null,
		mcp_registrations: mcpServers,
	});

	console.log(`ContextMind installed into ${projectRoot}`);
	console.log(`  hosts:    ${hosts.map((h) => h.id).join(", ") || "(none selected)"}`);
	console.log(`  hooks:    ${HOOK_FILES.length} files -> ${HOOK_SCRIPT_DIR}/`);
	console.log(`  library:  .cursor/contextmind/`);
	console.log(`  events:   ${[...new Set(HOOK_ENTRIES.map((e) => e.event))].join(", ")}`);
	for (const hi of hookInstalls) {
		console.log(`  hooks:    ${hi.host} [${hi.scope}] ${hi.entries} entries -> ${hi.file}`);
	}
	for (const reg of mcpServers) {
		if (reg.skipped) {
			console.log(`  mcp:      ${reg.host} skipped — ${reg.skipped}`);
			continue;
		}
		console.log(`  mcp:      ${reg.host} [${reg.scope}] -> ${reg.file}`);
		if (reg.scope === "user") {
			console.log(
				`            machine-wide: pinned to CONTEXTMIND_PROJECT_DIR=${resolve(projectRoot)}; reload ${reg.host} to load it`,
			);
		}
	}
	if (retired.size > 0) console.log(`  retired:  ${[...retired].join(", ")} (still in the backup)`);
	if (!flags.rules) console.log("  rules:    not copied (pass --rules to add the always rule)");
	const backups = [...hookInstalls.map((h) => h.backup), ...mcpServers.map((r) => r.backup)].filter(Boolean);
	for (const b of backups) console.log(`  backup:   ${b}`);
	return 0;
}

/** Re-register MCP mounts without wiping the library (node path + brain stdio). */
function repairMcp(projectRoot, flags = {}) {
	const libPath = join(projectRoot, ".cursor", "contextmind", "mcp-server.mjs");
	const serverPath = existsSync(libPath) ? libPath : join(HERE, "mcp-server.mjs");
	const hosts = selectInstallHosts(flags, projectRoot);
	const { node, results } = repairMcpMounts({
		projectRoot,
		serverPath,
		hosts,
		readJson,
		writeJson,
		backupOnce,
	});
	console.log(`MCP repair — node: ${node}`);
	for (const r of results) {
		if (r.skipped) {
			console.log(`  ${r.host}: skipped — ${r.skipped}`);
			continue;
		}
		if (r.ok) {
			console.log(`  ${r.host}: ${r.detail}`);
			continue;
		}
		console.log(`  ${r.host} [${r.scope}]: ${r.changes.join(", ")}`);
		console.log(`           -> ${r.file}`);
	}
	console.log("Reload MCP in each host (Cursor: Reload MCP; Qoder: restart).");
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

	// Strip only our hook entries, from every host file install may have written;
	// anything else the user configured stays. A Claude-shaped host keeps its rows
	// inside its own settings file under its own event spellings, so this has to
	// mirror installHooksForHost or the host reports a hook it can no longer find.
	const hookStripped = [];
	for (const profile of hostProfiles().filter((h) => supports(h, "hooks") && h.verified === true)) {
		const target = profile.hooks?.file;
		const file = resolveConfigFile(target, { projectRoot, home: userHome() });
		const doc = readJson(file);
		const keyPath = target?.keyPath || "hooks";
		const hooksRoot = doc?.[keyPath];
		if (!file || !hooksRoot || typeof hooksRoot !== "object") continue;
		let removed = 0;
		for (const [event, list] of Object.entries(hooksRoot)) {
			if (!Array.isArray(list)) continue;
			const kept = list.filter((h) => {
				if (!isOwnHookEntry(profile, h)) return true;
				removed += 1;
				return false;
			});
			if (kept.length > 0) hooksRoot[event] = kept;
			else delete hooksRoot[event];
		}
		if (removed > 0) writeJson(file, doc);
		hookStripped.push({ host: profile.id, file, removed });
	}

	// Strip only our entry from each host's MCP file; the files themselves and
	// every other server stay. This has to mirror registerMcpServers or uninstall
	// leaves a registered-but-deleted server behind, which hosts report as a
	// startup error long after the project is gone.
	const mcpJson = join(cursorDir, "mcp.json");
	const stripped = [];
	for (const profile of hostProfiles().filter((h) => supports(h, "mcp") && h.verified === true)) {
		const file = mcpConfigFile(profile.id, { projectRoot, home: userHome() });
		const keyPath = profile.mcp.keyPath || "mcpServers";
		const doc = readJson(file);
		if (!doc?.[keyPath]?.contextmind) continue;
		delete doc[keyPath].contextmind;
		if (Object.keys(doc[keyPath]).length === 0) delete doc[keyPath];
		writeJson(file, doc);
		stripped.push(`${profile.id}[${profile.mcp.scope}]`);
	}
	// Put back whatever install quarantined, so uninstall is a true inverse.
	const { restored } = unlockUpstreams(mcpJson);

	rmSync(join(cursorDir, MANIFEST_NAME), { force: true });
	console.log(`ContextMind removed from ${projectRoot}`);
	for (const h of hookStripped.filter((x) => x.removed > 0)) {
		console.log(`  hooks:    ${h.host} removed ${h.removed} entries <- ${h.file}`);
	}
	if (stripped.length > 0) console.log(`  mcp:      entry removed from ${stripped.join(", ")}`);
	if (restored.length > 0) console.log(`  upstreams: restored ${restored.join(", ")}`);
	console.log("  handle/telemetry databases left in place; delete .contextmind/ to drop them too.");
	return 0;
}

// ─── doctor ───

async function cmdStart() {
	const r = await startDaemon({ waitMs: 5_000, converge: true });
	if (!r.ok) {
		console.error(`start failed: ${r.error ?? "unknown"}`);
		return 1;
	}
	for (const c of r.converged ?? []) {
		console.log(`converged stale daemon :${c.port} — ${c.script} stamp=${c.stamp}`);
	}
	console.log(
		`TokenMind Runtime ${r.already ? "already listening" : "started"} at http://${r.host}:${r.port}/health` +
			(r.port === runtimePort() ? "" : ` (preferred ${runtimePort()} is held by another listener)`),
	);
	return 0;
}

async function cmdStop() {
	await stopDaemon();
	console.log("TokenMind Runtime stop requested");
	return 0;
}

function check(label, fn) {
	try {
		return { label, ...fn() };
	} catch (err) {
		return { label, status: "FAIL", detail: err instanceof Error ? err.message : String(err) };
	}
}

async function doctor(projectRoot) {
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

	for (const profile of hostProfiles().filter((h) => supports(h, "hooks") && h.verified === true)) {
		rows.push(
			check(`hooks installed (${profile.id})`, () => {
				const target = profile.hooks?.file;
				const file = resolveConfigFile(target, { projectRoot, home: userHome() });
				const hooksRoot = file ? readJson(file)?.[target?.keyPath || "hooks"] : null;
				if (!hooksRoot || typeof hooksRoot !== "object") return { status: "WARN", detail: `no ${file}` };
				const wanted = dedupeEntriesForHost(profile, HOOK_ENTRIES);
				// Config keys are the HOST's event names (Qoder: PreToolUse), not the canonical ones.
				const present = wanted.filter((e) => {
					const list = hooksRoot[hookEventName(profile, e.event) ?? e.event] ?? [];
					return Array.isArray(list) && list.some((h) => hookEntryPresent(h, e.hook));
				});
				const missing = wanted.filter((e) => !present.includes(e));
				if (missing.length === wanted.length) return { status: "WARN", detail: "not installed (run: contextmind install)" };
				return missing.length === 0
					? { status: "PASS", detail: `${wanted.length} entries -> ${file}` }
					: { status: "FAIL", detail: `missing: ${missing.map((m) => `${m.event}/${m.hook}`).join(", ")}` };
			}),
		);
	}

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
		await (async () => {
			const label = "codegraph spawn (orient)";
			if (cfg.adapters?.codegraph?.enabled === false) {
				return { label, status: "PASS", detail: "codegraph disabled" };
			}
			const projectCfg = { ...cfg, project_root: projectRoot };
			try {
				const { probeSidecar } = await import("./lib/codegraph-sidecar.mjs");
				const side = await probeSidecar(projectCfg, { spawnIfNeeded: false });
				if (side.ok) return { label, status: "PASS", detail: side.detail };
			} catch {
				/* CLI fallback */
			}
			const probe = probeCodegraphSpawn(projectCfg, { timeoutMs: 25_000 });
			if (probe.ok) return { label, status: "PASS", detail: probe.detail };
			const bin = cfg.adapters?.codegraph?.bin ?? "codegraph";
			const critical = process.platform === "win32" && /\.ps1$/i.test(String(bin));
			return critical
				? { label, status: "FAIL", detail: `${probe.detail} — orient will hang; fix PowerShell -File spawn` }
				: { label, status: "WARN", detail: probe.detail };
		})(),
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
		check("mcp server (seven tools)", () => {
			const mcp = readJson(join(projectRoot, ".cursor", "mcp.json"));
			const servers = Object.keys(mcp?.mcpServers ?? {});
			const ours = mcp?.mcpServers?.contextmind;
			if (!ours) return { status: "WARN", detail: "not installed (run: contextmind install)" };
			const script = Array.isArray(ours.args) ? ours.args[0] : null;
			if (!script || !existsSync(script)) {
				return { status: "FAIL", detail: `server script missing: ${script}` };
			}
			const forbidden = servers.filter((s) => FORBIDDEN_STANDING_UPSTREAMS.has(s));
			if (forbidden.length > 0) {
				return {
					status: "FAIL",
					detail: `standing forbidden MCP (schema tax): ${forbidden.join(", ")} — merge --remove or use CLI`,
				};
			}
			const upstreams = servers.filter((s) => s !== "contextmind");
			// Spec 5.5: during the S1-S3 transition upstreams may coexist, but
			// doctor must report the schema tax instead of staying quiet.
			return upstreams.length === 0
				? { status: "PASS", detail: `7 tools @ ${script}` }
				: { status: "WARN", detail: `7 tools; upstreams still visible: ${upstreams.join(", ")}` };
		}),
	);

	rows.push(
		check("hook JSON (node preTool)", () => {
			const hooksDest = join(projectRoot, ".cursor", "hooks");
			const script = join(hooksDest, "cm-pre-tool.mjs");
			if (!existsSync(script)) return { status: "FAIL", detail: "missing cm-pre-tool.mjs" };
			const sample = JSON.stringify({
				tool_name: "Shell",
				tool_input: { command: "echo ok" },
				cwd: projectRoot,
				workspace_roots: [projectRoot],
			});
			const r = spawnSync(process.execPath, [script], {
				input: sample,
				encoding: "utf8",
				timeout: 8_000,
				env: { ...process.env, CONTEXTMIND_HOME: join(projectRoot, ".cursor", "contextmind") },
				windowsHide: true,
			});
			if (r.status !== 0) return { status: "FAIL", detail: `exit ${r.status} ${(r.stderr || "").slice(0, 120)}` };
			const parsed = parseHookStdout(r.stdout);
			return parsed.ok
				? { status: "PASS", detail: "cm-pre-tool.mjs emits valid JSON" }
				: { status: "FAIL", detail: `${parsed.reason}: ${parsed.sample ?? ""}` };
		}),
	);

	rows.push(
		check("hook launcher policy", () => {
			const hooksDest = join(projectRoot, ".cursor", "hooks");
			const exe = join(hooksDest, "cmhook.exe");
			const marker = join(hooksDest, ".cmhook-json-ok");
			if (!existsSync(exe)) return { status: "PASS", detail: "node-only (no cmhook.exe)" };
			if (existsSync(marker)) return { status: "PASS", detail: "cmhook.exe + verify marker" };
			return {
				status: "FAIL",
				detail: "cmhook.exe without .cmhook-json-ok — run: contextmind fix-hooks [dir]",
			};
		}),
	);

	rows.push({
		label: "cmhook.exe (native client)",
		status: (() => {
			const hooksDest = join(projectRoot, ".cursor", "hooks");
			const exe = join(hooksDest, "cmhook.exe");
			const marker = join(hooksDest, ".cmhook-json-ok");
			if (!existsSync(exe)) return "WARN";
			return existsSync(marker) ? "PASS" : "FAIL";
		})(),
		detail: (() => {
			const hooksDest = join(projectRoot, ".cursor", "hooks");
			const exe = join(hooksDest, "cmhook.exe");
			const marker = join(hooksDest, ".cmhook-json-ok");
			if (!existsSync(exe)) return "missing — node thin client only";
			if (existsSync(marker)) return "verified native client";
			return "UNSAFE — run contextmind fix-hooks then install";
		})(),
	});

	// isListening() defaults to resolveRuntimePort() — the port in the pid file, i.e. the
	// one the daemon actually bound. Report that same port, not runtimePort() (the
	// *preferred* one): when the Brain dashboard holds 18787 the daemon falls back to an
	// ephemeral port, and printing the preferred port next to a PASS points at a different
	// process than the one that answered — a green row for the wrong listener.
	const listening = await isListening();
	const livePort = resolveRuntimePort();
	const preferredPort = runtimePort();
	rows.push({
		label: "tokenmind runtime",
		status: listening ? "PASS" : "WARN",
		detail: listening
			? `http://${runtimeHost()}:${livePort}/health${
					livePort === preferredPort ? "" : ` (preferred ${preferredPort} is held by another listener)`
				}`
			: "not listening — run: contextmind start",
	});

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

/** `--since 24h` / `--since 7d` / ISO string -> ISO timestamp (or null). */
function parseSince(value) {
	if (!value) return null;
	const m = String(value).match(/^(\d+)\s*(h|d|w)$/i);
	if (m) {
		const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2].toLowerCase()];
		return new Date(Date.now() - Number(m[1]) * unit).toISOString();
	}
	const t = Date.parse(value);
	return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function report(projectRoot, args) {
	const cfg = loadConfig(projectRoot);
	const t = openTelemetry(cfg);
	if (!t.available) {
		console.error(`telemetry unavailable: ${t.failed ?? "unknown"}`);
		return 1;
	}
	const since = parseSince(args.since);
	if (args.since && !since) {
		t.close();
		console.error(`invalid --since value: ${args.since} (use e.g. 24h, 7d, or an ISO timestamp)`);
		return 1;
	}
	const sessionId = args.session ?? null;
	const sum = t.summary({ since, sessionId });
	t.close();
	const period = sessionId
		? `session ${sessionId}`
		: since
			? `since ${since}`
			: "All time";
	if (args.json) console.log(JSON.stringify(sum, null, 2));
	else console.log(formatSummary(sum, { title: `ContextMind Token Ledger — ${projectRoot}`, period }));
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
			// A CLI self-report: no hook payload reached here, so no host to derive.
			host: "unknown",
			handleId,
			handleFetched: 1,
			// Ledger rule (S8, G-S8-06): a fetch is a spend, not a saving.
			// raw = emitted = what was actually returned.
			rawTokens: result.tokens,
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

// ─── task / scorecard / state (peak stack) ───

function taskCmd(projectRoot, positional) {
	const sub = positional[1] ?? "validate";
	const cfg = loadConfig(projectRoot);
	if (sub === "validate") {
		const v = validateActiveTaskBundle(projectRoot, cfg);
		if (!v.ok) {
			console.error(`task validate FAIL: ${v.error} (${v.path ?? ""})`);
			return 1;
		}
		console.log(`task validate: OK (${v.path})`);
		return 0;
	}
	console.error(`unknown task subcommand: ${sub}`);
	return 1;
}

function scorecardCmd(projectRoot, flags) {
	const cfg = loadConfig(projectRoot);
	const telemetry = openTelemetry(cfg);
	try {
		const view = projectScorecardView(projectRoot, cfg, telemetry, {});
		if (flags.json) {
			console.log(JSON.stringify(view, null, 2));
			return 0;
		}
		console.log(JSON.stringify(view?.scorecard ?? view, null, 2));
		return 0;
	} finally {
		telemetry.close();
	}
}

function stateCmd(projectRoot, positional) {
	const sub = positional[1] ?? "sync";
	const cfg = loadConfig(projectRoot);
	if (sub === "sync") {
		initAgentStateScaffold(projectRoot);
		const r = syncAgentStateFromTaskBundle(projectRoot, cfg);
		if (!r.ok) {
			console.error(`state sync FAIL: ${r.reason}`);
			return 1;
		}
		console.log("state sync: OK");
		return 0;
	}
	console.error(`unknown state subcommand: ${sub}`);
	return 1;
}

function resolveProjectRoot(command, positional, flags) {
	if (flags.dir) return resolve(flags.dir);
	if (["install", "uninstall", "doctor", "status", "dashboard", "fix-hooks"].includes(command) && positional[1]) {
		return resolve(positional[1]);
	}
	return resolve(process.cwd());
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
  contextmind report [--since 24h|7d|ISO] [--session ID] [--json]   Three-column token ledger
  contextmind dashboard [dir] [--port 8899]    Live read-only token ledger UI (Ctrl+C to stop)
  contextmind gc [--days 30]       Prune telemetry, expire handles
  contextmind fetch <handle> [--lines a-b] [--pattern re] [--jsonPath p] [--offset n]
  contextmind config [--validate]
  contextmind benchmark [--fixtures DIR]
  contextmind task validate [dir]     Validate .contextmind/task.active.json
  contextmind scorecard [--json]      Stack health scorecard
  contextmind state sync [dir]        Sync .agent/state from TaskBundle
  contextmind fix-hooks [dir]       Emergency: node-only .cmd, disable bad cmhook.exe
  contextmind mcp repair [dir]      Fix MCP node path + project-brain stdio (no library wipe)
  contextmind start                   Start TokenMind Runtime (localhost)
  contextmind stop                    Stop TokenMind Runtime`;

export async function main(argv = process.argv.slice(2)) {
	const { positional, flags } = parseArgs(argv);
	const command = positional[0] ?? "help";
	const projectRoot = resolveProjectRoot(command, positional, flags);

	switch (command) {
		case "install":
			return await install(projectRoot, flags);
		case "fix-hooks":
			return fixHooks(projectRoot);
		case "mcp":
			if ((positional[1] ?? "repair") === "repair") return repairMcp(projectRoot, flags);
			console.error("usage: contextmind mcp repair [dir]");
			return 1;
		case "uninstall":
			return uninstall(projectRoot);
		case "doctor":
			return await doctor(projectRoot);
		case "start":
			return await cmdStart();
		case "stop":
			return await cmdStop();
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
		case "task":
			return taskCmd(projectRoot, positional);
		case "scorecard":
			return scorecardCmd(projectRoot, flags);
		case "state":
			return stateCmd(projectRoot, positional);
		case "dashboard":
			// Read-only view over telemetry (owner-approved 2C exception).
			// spawn + inherit stdio: Ctrl+C stops both; exit code propagates.
			{
				const port = String(flags.port ?? 8899);
				const child = spawn(process.execPath, [join(HERE, "dashboard.mjs"), projectRoot, "--port", port], {
					stdio: "inherit",
				});
				child.on("error", (err) => {
					console.error(`dashboard failed to start: ${err.message}`);
					process.exit(1);
				});
				// Keep this process alive alongside the child (it holds stdio).
				child.on("exit", (code) => process.exit(code ?? 0));
				return 0;
			}
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
	main().then((code) => process.exit(code ?? 0));
}

export { DEFAULTS, ENGINE_ROOT, classify };
