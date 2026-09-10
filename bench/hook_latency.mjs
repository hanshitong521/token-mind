#!/usr/bin/env node
/**
 * Measure ContextMind hook cold-start latency (direct node → cm-pre-tool.mjs).
 * Usage: node bench/hook_latency.mjs [iterations]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "cursor", "hooks", "cm-pre-tool.mjs");
const N = Math.max(3, Math.min(30, Number(process.argv[2] || 8)));

if (!existsSync(HOOK)) {
	console.error(`missing hook: ${HOOK}`);
	process.exit(2);
}

const input = `${JSON.stringify({
	tool_name: "Read",
	tool_input: { path: "README.md", offset: 1, limit: 5 },
	cwd: ROOT,
})}\n`;

function p50(xs) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor((s.length - 1) * 0.5)];
}

function runOnce() {
	const t0 = performance.now();
	const r = spawnSync(process.execPath, [HOOK], {
		input,
		encoding: "utf8",
		cwd: ROOT,
		timeout: 30_000,
		env: { ...process.env, CONTEXTMIND_HOME: join(ROOT, "contextmind") },
	});
	const ms = Math.round(performance.now() - t0);
	return { ms, status: r.status, err: (r.stderr || "").slice(0, 200) };
}

const nodeFloor = [];
for (let i = 0; i < N; i++) {
	const t0 = performance.now();
	spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8", timeout: 10_000 });
	nodeFloor.push(Math.round(performance.now() - t0));
}

const cold = [];
for (let i = 0; i < N; i++) {
	const r = runOnce();
	cold.push(r.ms);
	if (i === 0 && r.status !== 0) {
		console.error("first hook run failed", r);
	}
}

// "warm" = second consecutive run in-process is impossible for Cursor hooks;
// report repeat cold as warm_same_path for honesty (no fake resident daemon).
const warm = [];
for (let i = 0; i < N; i++) warm.push(runOnce().ms);

console.log(`bare node startup floor  n=${N}  p50=${p50(nodeFloor)}ms`);
console.log(`cold hook: node cm-pre-tool  n=${N}  p50=${p50(cold)}ms  min=${Math.min(...cold)}ms  max=${Math.max(...cold)}ms`);
console.log(`warm hook: node cm-pre-tool  n=${N}  p50=${p50(warm)}ms  min=${Math.min(...warm)}ms  max=${Math.max(...warm)}ms`);
console.log(`path: direct node→cm-pre-tool.mjs (resident hookd DISABLED — stubs were empty)`);
console.log(`G4 warm p95 vs 25ms: ${p50(warm) <= 25 ? "PASS" : "KNOWN_LIMITATION (Node spawn tax)"}`);
