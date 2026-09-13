#!/usr/bin/env node
/**
 * One-shot agent-stack smoke (hang / peak / hooks).
 *   node scripts/run-agent-stack-smoke.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRAIN_MCP_URL = (process.env.BRAIN_MCP_URL || "http://127.0.0.1:18788/mcp").replace(/\/$/, "");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = join(ROOT, ".agent");
const CM = join(ROOT, ".cursor", "contextmind");

function run(label, cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, {
		cwd: ROOT,
		encoding: "utf8",
		timeout: opts.timeout ?? 120_000,
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
		...opts,
	});
	const ok = r.status === 0;
	console.log(`\n=== ${label} ${ok ? "PASS" : "FAIL"} (exit ${r.status}) ===`);
	if (!ok) {
		console.log((r.stderr || r.stdout || "").slice(-2000));
	}
	return ok;
}

async function brainHttpSmoke() {
	try {
		const h = await fetch("http://127.0.0.1:18788/health", { signal: AbortSignal.timeout(3000) });
		if (!h.ok) throw new Error(`health ${h.status}`);
		const r = await fetch(BRAIN_MCP_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "smoke", version: "1" },
				},
			}),
			signal: AbortSignal.timeout(5000),
		});
		if (!r.ok) throw new Error(`mcp ${r.status}`);
		return true;
	} catch (e) {
		console.log(`\n=== brain-http FAIL ===\n${e.message}`);
		return false;
	}
}

const steps = [
	["ensure-deps", process.execPath, [join(ROOT, "scripts/ensure-agent-stack-deps.mjs")]],
	["contextmind-unit", process.execPath, [join(ROOT, "scripts/run-contextmind-unit-smoke.mjs")]],
	["install-uninstall-e2e", process.execPath, [join(ROOT, "scripts/run-install-uninstall-e2e.mjs")]],
	["hooks+fast-allow", process.execPath, ["--test", join(CM, "tests/fast-allow-pre.test.mjs"), join(CM, "tests/hooks.test.mjs")]],
	["doctor", process.execPath, [join(ROOT, ".cursor/contextmind/cli.mjs"), "doctor", ROOT]],
	["bench-codegraph-sidecar", process.execPath, [join(ROOT, "scripts/bench-codegraph-sidecar.mjs")]],
	["hook-latency-peak", process.execPath, [join(ROOT, "scripts/hook-latency-peak.mjs"), "6"]],
	["peak-speed-bench", process.execPath, [join(ROOT, "scripts/peak-speed-bench.mjs")]],
];

const results = {};
let failed = 0;
for (const [label, cmd, args] of steps) {
	const ok = run(label, cmd, args, label === "doctor" ? { timeout: 90_000 } : {});
	results[label] = ok;
	if (!ok) failed++;
}

const brainOk = await brainHttpSmoke();
results["brain-http"] = brainOk;
console.log(`\n=== brain-http ${brainOk ? "PASS" : "FAIL"} (${BRAIN_MCP_URL}) ===`);
if (!brainOk) failed++;

for (const [label, script] of [
	["g0-session-snapshot", "run-g0-session-snapshot.mjs"],
	["g1-mcp-verify", "run-g1-mcp-verify.mjs"],
	["g3-token-evidence", "run-g3-token-evidence.mjs"],
	["g8-consumer-gate", "run-g8-consumer-gate.mjs"],
	["token-mind-dod", "token-mind-product-dod.mjs"],
]) {
	const args = label === "token-mind-dod" ? ["--latency"] : [];
	const ok = run(label, process.execPath, [join(ROOT, "scripts", script), ...args]);
	results[label] = ok;
	if (!ok) failed++;
}

const total = Object.keys(results).length;
const passed = Object.values(results).filter(Boolean).length;
if (!existsSync(AGENT)) mkdirSync(AGENT, { recursive: true });
writeFileSync(
	join(AGENT, "agent-stack-smoke-last.json"),
	`${JSON.stringify({ at: new Date().toISOString(), ok: failed === 0, passed, total, results }, null, 2)}\n`,
);

console.log(`\n--- smoke: ${passed}/${total} passed ---`);
process.exit(failed ? 1 : 0);
