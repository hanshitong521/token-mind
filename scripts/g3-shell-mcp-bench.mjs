#!/usr/bin/env node
/**
 * G3 shell/MCP median compression evidence (spec −60% / −70%).
 *   node scripts/g3-shell-mcp-bench.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = join(ROOT, ".agent");
const OUT = join(AGENT, "g3-shell-mcp-bench-last.json");

const { loadConfig } = await import(pathToFileURL(join(ROOT, ".cursor/contextmind/lib/config.mjs")).href);
const { runOutputGate } = await import(pathToFileURL(join(ROOT, ".cursor/contextmind/lib/output-gate.mjs")).href);
const { HandleStore } = await import(pathToFileURL(join(ROOT, ".cursor/contextmind/lib/handles.mjs")).href);

const cfg = loadConfig(ROOT);
const handles = new HandleStore({
	dbPath: join(AGENT, "g3-bench-gate.db"),
	enabled: true,
	maxDiskMb: 8,
});

const shellRaw = Array.from({ length: 500 }, (_, i) => ` M shejiu-modules/mod${i % 40}/File${i}.java`).join("\n");
const shellGate = runOutputGate({
	raw: shellRaw,
	cmd: "git status -sb",
	surface: "shell",
	cfg,
	handles,
	sessionId: "g3-bench",
});
const shellRatio = shellGate.rawTokens > 0 ? 1 - shellGate.emittedTokens / shellGate.rawTokens : 0;

let mcpRatio = 0;
let mcpRaw = null;
let mcpEmitted = null;
const orientPath = join(AGENT, "orient-dup-bench-last.json");
if (existsSync(orientPath)) {
	const orient = JSON.parse(readFileSync(orientPath, "utf8"));
	mcpRaw = orient.orient?.gate_raw;
	mcpEmitted = orient.orient?.gate_emitted;
	if (mcpRaw > 0 && mcpEmitted != null) mcpRatio = 1 - mcpEmitted / mcpRaw;
}

const bigMcp = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, payload: "x".repeat(120) })));
const mcpGate = runOutputGate({
	raw: bigMcp,
	surface: "mcp",
	toolName: "mysql_query",
	cfg,
	handles,
	sessionId: "g3-bench-mcp",
});
const mcpPostRatio = mcpGate.rawTokens > 0 ? 1 - mcpGate.emittedTokens / mcpGate.rawTokens : 0;

const shellPass = shellRatio >= 0.6;
const mcpPass = mcpRatio >= 0.7 || mcpPostRatio >= 0.7;
const ok = shellPass && mcpPass;

const rec = {
	at: new Date().toISOString(),
	shell: {
		raw_tokens: shellGate.rawTokens,
		emitted_tokens: shellGate.emittedTokens,
		saved_ratio: +shellRatio.toFixed(4),
		pass_minus_60: shellPass,
	},
	mcp_orient: {
		raw_tokens: mcpRaw,
		emitted_tokens: mcpEmitted,
		saved_ratio: mcpRaw ? +mcpRatio.toFixed(4) : null,
	},
	mcp_post: {
		raw_tokens: mcpGate.rawTokens,
		emitted_tokens: mcpGate.emittedTokens,
		saved_ratio: +mcpPostRatio.toFixed(4),
		pass_minus_70: mcpPostRatio >= 0.7,
	},
	gate_g3_shell_mcp: ok ? "PASS" : "FAIL",
	ok,
};

mkdirSync(AGENT, { recursive: true });
writeFileSync(OUT, `${JSON.stringify(rec, null, 2)}\n`);
console.log(
	`g3 shell/mcp bench: ${ok ? "PASS" : "FAIL"} shell=${(shellRatio * 100).toFixed(1)}% mcp_orient=${(mcpRatio * 100).toFixed(1)}% mcp_post=${(mcpPostRatio * 100).toFixed(1)}%`,
);
process.exit(ok ? 0 : 1);
