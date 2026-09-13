#!/usr/bin/env node
/**
 * Hook latency: cmhook.exe (preferred) vs node thin client → TokenMind Runtime.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { startDaemon, stopDaemon } from "../contextmind/lib/runtime/lifecycle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = join(ROOT, "cursor", "hooks");
const CMHOOK = join(HOOKS, "cmhook.exe");
const NODE_HOOK = join(HOOKS, "cm-pre-tool.mjs");
const N = Math.max(3, Math.min(30, Number(process.argv[2] || 12)));

const input = `${JSON.stringify({
	tool_name: "Write",
	tool_input: {},
	conversation_id: "bench-latency",
	cwd: ROOT,
	workspace_roots: [ROOT],
})}\n`;

function pct(xs, p) {
	const s = [...xs].sort((a, b) => a - b);
	const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
	return s[i];
}

function runCmhook() {
	const t0 = performance.now();
	const r = spawnSync(CMHOOK, ["cm-pre-tool"], {
		input,
		encoding: "utf8",
		cwd: HOOKS,
		timeout: 30_000,
		windowsHide: true,
	});
	return { ms: Math.round(performance.now() - t0), status: r.status, out: (r.stdout || "").trim() };
}

function runNodeHook() {
	const t0 = performance.now();
	const r = spawnSync(process.execPath, [NODE_HOOK], {
		input,
		encoding: "utf8",
		cwd: ROOT,
		timeout: 60_000,
		env: { ...process.env, CONTEXTMIND_HOME: join(ROOT, "contextmind") },
	});
	return { ms: Math.round(performance.now() - t0), status: r.status };
}

console.log("Starting TokenMind Runtime…");
const started = await startDaemon({ waitMs: 6_000 });
if (!started.ok) console.error("daemon start:", started);

const pathLabel = existsSync(CMHOOK) ? "cmhook.exe → runtime" : "node thin → runtime (build native\\build-cmhook.cmd)";
const warm = [];
for (let i = 0; i < N; i++) {
	warm.push(existsSync(CMHOOK) ? runCmhook().ms : runNodeHook().ms);
}

const p50 = pct(warm, 50);
const p95 = pct(warm, 95);
const p99 = pct(warm, 99);

console.log(`${pathLabel}  n=${N}  p50=${p50}ms  p95=${p95}ms  p99=${p99}ms  min=${Math.min(...warm)}  max=${Math.max(...warm)}`);
console.log(`production bar: p50<20 p95<50 p99<100 → ${p50 < 20 && p95 < 50 && p99 < 100 ? "PASS" : "FAIL/KNOWN"}`);
console.log(`operational bar (Windows spawn): p50<=60 p95<=80 p99<=100 → ${p50 <= 60 && p95 <= 80 && p99 <= 100 ? "PASS" : "FAIL"}`);

const baseline = {
	ts: new Date().toISOString(),
	iterations: N,
	client: existsSync(CMHOOK) ? "cmhook.exe" : "node-thin",
	thin_runtime_warm: { p50_ms: p50, p95_ms: p95, p99_ms: p99, min_ms: Math.min(...warm), max_ms: Math.max(...warm) },
	production_bar: { p50: 20, p95: 50, p99: 100 },
	pass: p50 < 20 && p95 < 50 && p99 < 100,
};

const evidenceDir = join(ROOT, "docs", "evidence");
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, "baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`);
writeFileSync(
	join(evidenceDir, "SLICE_RUNTIME_V2.md"),
	`# TokenMind Runtime v2 slice\n\n- ${baseline.ts}\n- client: ${baseline.client}\n- p50/p95/p99: ${p50}/${p95}/${p99} ms\n- production pass: ${baseline.pass}\n`,
);

await stopDaemon();
