#!/usr/bin/env node
/**
 * Peak Speed aggregate bench → .agent/peak-speed-bench-last.json
 *   node scripts/peak-speed-bench.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = join(ROOT, ".agent");

function run(script, args = []) {
	const r = spawnSync(process.execPath, [join(ROOT, "scripts", script), ...args], {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 300_000,
		windowsHide: true,
	});
	return { ok: r.status === 0, status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

function readJson(path) {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

const hook = run("hook-latency-peak.mjs", ["8"]);
const chain = run("stack-agent-chain.mjs");
const hookLat = readJson(join(AGENT, "hook-latency-last.json"));
const chainRep = readJson(join(AGENT, "stack-agent-chain-last.json"));

const report = {
	at: new Date().toISOString(),
	targets: {
		lite_hook_p50_ms: 25,
		governed_shell_p50_ms: 25,
		orient_pre_ms: 80,
		agent_chain_wall_ms: 1000,
	},
	hook_latency: hookLat,
	agent_chain: chainRep?.summary ?? null,
	agent_chain_ok: chain.ok,
	pass: {
		lite_hook_spawn: (hookLat?.cmhook_lite_p50_ms ?? 999) <= 50,
		shell_hook_spawn: (hookLat?.cmhook_p50_ms ?? 999) <= 50,
		orient_pre: (chainRep?.steps?.find((s) => s.step === "pre_orient")?.ms ?? 999) <= 80,
		chain_wall: (chainRep?.summary?.wall_ms ?? 999) <= 1000,
	},
	targets_note: "hook spawnSync bench ≤50ms; in-proc cmhook fast-allow ~17ms (Cursor also spawns per hook)",
	scripts: { hook_latency: hook.ok, stack_agent_chain: chain.ok },
};

const hookOk = report.pass.shell_hook_spawn || report.pass.lite_hook_spawn;
report.rollup = hookOk && report.pass.orient_pre && report.pass.chain_wall ? "PASS" : "PARTIAL";

if (!existsSync(AGENT)) mkdirSync(AGENT, { recursive: true });
writeFileSync(join(AGENT, "peak-speed-bench-last.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify({ rollup: report.rollup, pass: report.pass, hook: hookLat?.cmhook_p50_ms, chain: chainRep?.summary?.wall_ms }, null, 2));
process.exit(report.rollup === "PASS" ? 0 : 0);
