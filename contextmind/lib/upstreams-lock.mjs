/**
 * Quarantine raw upstream MCP servers (codegraph) from `.cursor/mcp.json`.
 *
 * ContextMind routes exploration through context_orient + the local codegraph CLI.
 * Leaving codegraph registered duplicates tools (~schema tax) and lets agents bypass
 * preToolUse when Cursor exposes MCP without hook coverage.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Servers removed from the agent-visible catalogue (restored on uninstall). */
export const QUARANTINE_SERVER_NAMES = ["codegraph"];

/** Servers that may stay registered alongside contextmind (not quarantined by default). */
export const ALLOWED_VISIBLE_UPSTREAMS = new Set([
	"ads-mysql",
	"project-brain",
	"ads-mysql-prod",
]);

/** Must never sit in standing mcp.json (schema tax). Use CLI / temporary snippet only. */
export const FORBIDDEN_STANDING_UPSTREAMS = new Set(["testmind", "codegraph", "headroom", "hearoom-mind"]);

export const LOCK_SUFFIX = ".contextmind-upstreams-lock.json";

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

export function lockPathFor(mcpJsonPath) {
	return `${mcpJsonPath}${LOCK_SUFFIX}`;
}

/**
 * Move quarantined servers from active mcp.json into the lock file.
 * @returns {{ quarantined: string[], lockPath: string | null }}
 */
export function lockUpstreams(mcpJsonPath, names = QUARANTINE_SERVER_NAMES) {
	if (!existsSync(mcpJsonPath)) return { quarantined: [], lockPath: null };
	const mcp = readJson(mcpJsonPath, { mcpServers: {} }) ?? { mcpServers: {} };
	if (!mcp.mcpServers || typeof mcp.mcpServers !== "object") mcp.mcpServers = {};

	const lockPath = lockPathFor(mcpJsonPath);
	const lock = readJson(lockPath, { mcpServers: {} }) ?? { mcpServers: {} };
	if (!lock.mcpServers || typeof lock.mcpServers !== "object") lock.mcpServers = {};

	const quarantined = [];
	for (const name of names) {
		if (!mcp.mcpServers[name]) continue;
		lock.mcpServers[name] = mcp.mcpServers[name];
		delete mcp.mcpServers[name];
		quarantined.push(name);
	}

	if (quarantined.length > 0) {
		writeJson(lockPath, lock);
		writeJson(mcpJsonPath, mcp);
	}
	return { quarantined, lockPath: quarantined.length > 0 ? lockPath : existsSync(lockPath) ? lockPath : null };
}

/**
 * Restore quarantined servers from the lock file into mcp.json.
 */
export function unlockUpstreams(mcpJsonPath) {
	const lockPath = lockPathFor(mcpJsonPath);
	if (!existsSync(lockPath)) return { restored: [], lockPath };
	const mcp = readJson(mcpJsonPath, { mcpServers: {} }) ?? { mcpServers: {} };
	if (!mcp.mcpServers || typeof mcp.mcpServers !== "object") mcp.mcpServers = {};
	const lock = readJson(lockPath, { mcpServers: {} }) ?? { mcpServers: {} };
	const restored = [];
	for (const [name, entry] of Object.entries(lock.mcpServers ?? {})) {
		if (mcp.mcpServers[name]) continue;
		mcp.mcpServers[name] = entry;
		restored.push(name);
	}
	writeJson(mcpJsonPath, mcp);
	return { restored, lockPath };
}

/** Doctor: servers that should not appear in active mcp.json. */
export function forbiddenVisibleUpstreams(serverNames) {
	return serverNames.filter((s) => s !== "contextmind" && QUARANTINE_SERVER_NAMES.includes(s));
}
