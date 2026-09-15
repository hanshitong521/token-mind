/**
 * Repair MCP mount entries across agent hosts — idempotent, no library wipe.
 *
 * Fixes two recurring drift modes:
 * 1. contextmind registered with Python nodejs_wheel (install used process.execPath)
 * 2. project-brain on Cursor using HTTP url transport instead of venv stdio
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { loadConfig } from "./config.mjs";
import { mcpConfigFile, supports } from "./hosts.mjs";
import { shejiuDataRoot } from "./shejiu-data-root.mjs";
import { wrapNodeBin } from "./shell-guard.mjs";

/**
 * Build the project-brain stdio entry for a host.
 *
 * `cwd` is host-conditional. Cursor accepts it, but a user-scope connector file
 * (WorkBuddy's `~/.workbuddy/connectors/default/mcp.json`, CodeBuddy's
 * `~/.codebuddy/mcp.json`) is read by a loader that may not implement it, and a key
 * it ignores is harmless while a key it *rejects* breaks the whole server entry.
 * The Brain does not need `cwd` anyway: server.py resolves its package root from
 * `__file__` and re-injects it into sys.path ("Cursor / MCP may ignore cwd"), so
 * PYTHONPATH alone is sufficient. Profiles that declare `mcp.cwdSupported: false`
 * therefore get no `cwd` key at all rather than a `cwd` that is silently dropped.
 *
 * @param {any} profile host profile; null falls back to the legacy cursor behaviour
 */
/**
 * Locate the Brain venv — configured, or found beside the project.
 *
 * A profile can declare "this host wants the Brain mounted" (mcp.mountBrain), but the
 * venv path is per-machine, and `brain.python` defaults to "". An install that only
 * read config therefore skipped the Brain on every fresh host, silently: no error,
 * just one server fewer. WorkBuddy is the first host where the gap is visible — it is
 * user-scope, so no project config ever had a path written into it for that host.
 *
 * Fall back to the sibling checkout (both repos sit under one root in this workspace)
 * before giving up. An explicit configured path still wins, and a configured path that
 * no longer exists is not silently replaced — the caller must be able to see that the
 * Brain is missing rather than have it quietly repointed.
 */
export function detectBrainPython(projectRoot, cfg) {
	const configured = cfg?.brain?.python ? String(cfg.brain.python).trim() : "";
	if (configured) return resolve(configured);
	const root = resolve(projectRoot);
	for (const base of [dirname(root), root]) {
		for (const leaf of [
			join("project-brain-agent", ".venv", "Scripts", "python.exe"),
			join("project-brain-agent", ".venv", "bin", "python"),
		]) {
			const candidate = join(base, leaf);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

export function brainStdioEntry(projectRoot, cfg, profile = null) {
	const py = detectBrainPython(projectRoot, cfg);
	if (!py || !existsSync(py)) return null;
	const brainRoot = resolve(dirname(py), "..", "..");
	const projectId = String(cfg?.brain?.project_id ?? "shejiuPro").trim();
	const cwdSupported = profile?.mcp?.cwdSupported !== false;
	return {
		type: "stdio",
		command: py,
		args: ["-u", "-m", "brain_mcp.server"],
		...(cwdSupported ? { cwd: brainRoot } : {}),
		env: {
			PYTHONPATH: join(brainRoot, "src"),
			PYTHONUTF8: "1",
			PYTHONUNBUFFERED: "1",
			PYTHONIOENCODING: "utf-8",
			BRAIN_DEFAULT_PROJECT_ID: projectId,
			BRAIN_UPLOADER: String(profile?.id ?? "unknown"),
			BRAIN_REPO_ROOT: resolve(projectRoot),
			BRAIN_REPO_ROOT_SHEJIUPRO: resolve(projectRoot),
			BRAIN_PROJECT_ALIASES: "shejiuTest=shejiuPro",
			SHEJIU_DATA_ROOT: shejiuDataRoot(),
		},
	};
}

export function contextmindStdioEntry(projectRoot, serverPath, profile, projCfg, prevEntry) {
	const env = {
		CONTEXTMIND_PROJECT_DIR: resolve(projectRoot),
		SHEJIU_DATA_ROOT: shejiuDataRoot(),
	};
	if (projCfg?.cache_engine?.kvUrl) env.CONTEXTMIND_KV_BRIDGE_URL = String(projCfg.cache_engine.kvUrl);
	const prevEnv = prevEntry?.env;
	if (prevEnv && typeof prevEnv === "object") {
		for (const [k, v] of Object.entries(prevEnv)) {
			if (v != null && env[k] === undefined) env[k] = v;
		}
	}
	return {
		type: "stdio",
		command: wrapNodeBin(),
		args: [serverPath],
		env,
		...(profile.mcp?.fields || {}),
	};
}

function wheelNode(command) {
	return /nodejs_wheel/i.test(String(command ?? ""));
}

export function repairMcpMounts({ projectRoot, serverPath, hosts, readJson, writeJson, backupOnce }) {
	const projCfg = loadConfig(projectRoot);
	const node = wrapNodeBin();
	const results = [];

	for (const profile of hosts.filter((h) => supports(h, "mcp"))) {
		if (profile.verified !== true) {
			results.push({ host: profile.id, skipped: profile.unverifiedReason || "unverified" });
			continue;
		}
		const file = mcpConfigFile(profile.id, { projectRoot, home: process.env.CONTEXTMIND_INSTALL_HOME || process.env.USERPROFILE || process.env.HOME });
		if (!file) {
			results.push({ host: profile.id, skipped: "no mcp config path" });
			continue;
		}
		const keyPath = profile.mcp.keyPath || "mcpServers";
		const backup = backupOnce(file, ".contextmind-mcp-backup");
		const doc = readJson(file, {}) ?? {};
		if (!doc[keyPath] || typeof doc[keyPath] !== "object") doc[keyPath] = {};
		const servers = doc[keyPath];
		const changes = [];

		const prevCtx = servers.contextmind;
		const nextCtx = contextmindStdioEntry(projectRoot, serverPath, profile, projCfg, prevCtx);
		if (!prevCtx || wheelNode(prevCtx.command) || prevCtx.command !== node) {
			servers.contextmind = nextCtx;
			changes.push(`contextmind → ${node}`);
		}

		// project-brain mount — driven by profile.mcp.mountBrain, not by host id.
		// Cursor used to be the only host whose profile carried this because it was
		// the first project-scope MCP target; WorkBuddy is user-scope and still needs
		// the Brain, so the decision belongs to the profile's declared intent rather
		// than to a hardcoded host name (the same "no if (host === 'cursor')" rule
		// docs/AGENT-HOST-COMPAT.md states for the rest of this layer).
		if (profile.mcp?.mountBrain === true) {
			const prevBrain = servers["project-brain"];
			const needs =
				!prevBrain ||
				prevBrain.url ||
				wheelNode(prevBrain?.command) ||
				(profile.mcp?.cwdSupported === false && Object.hasOwn(prevBrain, "cwd")) ||
				prevBrain?.env?.BRAIN_UPLOADER !== profile.id;
			if (needs) {
				const brain = brainStdioEntry(projectRoot, projCfg, profile);
				if (brain) {
					servers["project-brain"] = brain;
					changes.push(prevBrain?.url ? "project-brain url→stdio" : "project-brain stdio/identity");
				} else {
					changes.push("project-brain skipped (venv python missing)");
				}
			}
		}

		if (changes.length === 0) {
			results.push({ host: profile.id, file, ok: true, detail: "already correct" });
			continue;
		}
		writeJson(file, doc);
		results.push({
			host: profile.id,
			file,
			scope: profile.mcp.scope,
			backup: existsSync(backup) ? backup : null,
			changes,
		});
	}
	return { node, results };
}
