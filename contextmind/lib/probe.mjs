/**
 * sessionStart adapter health (spec 5.5, scenario H).
 *
 * Honest scope: this reads `<project>/.cursor/mcp.json`, which is a
 * *declaration*. Cursor's live tool catalogue is not observable from a hook, so
 * a server present here may still be absent from the session (the failure mode
 * spec 1.1 item 15 describes). What this detects is "the rule depends on an
 * adapter that is not even configured", which is the common case and is worth
 * saying out loud in the first turn rather than discovering at call time.
 *
 * The warning is budgeted at 120 tokens and must name the missing server — a
 * generic "some adapters are missing" is not actionable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codegraphBin, commandAvailable } from "./bin-probe.mjs";
import { countTokens } from "./tokens.mjs";

function adapterSatisfied(name, adapter, declaredLower, cfg) {
	const servers = adapter.servers ?? [];
	const inMcp = servers.some((s) => declaredLower.some((d) => d.includes(s.toLowerCase())));
	if (inMcp) return true;
	if (name === "codegraph" && commandAvailable(codegraphBin(cfg))) return true;
	return false;
}

export const WARNING_TOKEN_BUDGET = 120;

/**
 * @returns {{configured: string[], missing: Array<{name:string, servers:string[]}>, declared: string[]}}
 */
export function probeAdapters(cfg, projectRoot) {
	let declared = [];
	try {
		const raw = JSON.parse(readFileSync(join(projectRoot, ".cursor", "mcp.json"), "utf8"));
		declared = Object.keys(raw?.mcpServers ?? {});
	} catch {
		declared = [];
	}
	const lower = declared.map((d) => d.toLowerCase());

	const missing = [];
	for (const [name, adapter] of Object.entries(cfg.adapters ?? {})) {
		if (!adapter?.enabled) continue;
		const servers = adapter.servers ?? [];
		if (adapterSatisfied(name, adapter, lower, cfg)) continue;
		missing.push({ name, servers });
	}
	return { configured: declared, missing, declared };
}

/**
 * Build the session-start warning. Returns null when nothing is missing, so the
 * session is not polluted by a no-op notice.
 */
export function adapterWarning(report) {
	if (!report.missing || report.missing.length === 0) return null;
	const names = report.missing.map((m) => m.name).join(",");
	const text = `[contextmind] adapter not configured: ${names} — dependent routing is degraded; Read Guard is unaffected.`;
	if (countTokens(text) > WARNING_TOKEN_BUDGET) {
		return `[contextmind] adapters not configured: ${report.missing.length}; Read Guard unaffected.`;
	}
	return text;
}

/** The telemetry rows to record, one per missing adapter. */
export function missingEvents(report, sessionId) {
	return report.missing.map((m) => ({
		surface: "adapter",
		toolName: m.name,
		adapterMissing: m.servers.join("|") || m.name,
		sessionId,
		rawTokens: 0,
		emittedTokens: 0,
		success: false,
	}));
}
