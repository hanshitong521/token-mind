#!/usr/bin/env node
/**
 * Hook latency attribution (G4).
 *
 * Splits one hook invocation into the parts that can be optimised separately:
 * bare Node startup, the ContextMind module graph, runtime/SQLite setup, and
 * whatever the hook itself decides to do. Without this split a "hooks are slow"
 * report optimises the wrong thing — the first time this was run, the cost was
 * assumed to be the module graph when the floor was Node itself.
 *
 * Usage: node bench/hook_latency.mjs [iterations]
 */

import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const N = Number(process.argv[2] ?? 15);

const PAYLOAD = JSON.stringify({
	tool_name: "Shell",
	tool_input: { command: "git status" },
	conversation_id: "latency-bench",
});

function bench(label, args, input = null) {
	const times = [];
	for (let i = 0; i < N; i++) {
		const started = performance.now();
		const res = spawnSync(process.execPath, args, {
			input,
			encoding: "utf8",
			windowsHide: true,
			timeout: 60_000,
			cwd: ROOT,
		});
		times.push(performance.now() - started);
		if (res.error) throw res.error;
	}
	times.sort((a, b) => a - b);
	const p = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))].toFixed(0);
	console.log(`${label.padEnd(34)} min=${times[0].toFixed(0)}ms  p50=${p(0.5)}ms  max=${times[times.length - 1].toFixed(0)}ms`);
	return times;
}

const hook = resolve(ROOT, "cursor", "hooks", "cm-pre-tool.mjs");

console.log(`node ${process.versions.node}  n=${N}`);
bench("bare node startup floor", ["-e", ""]);
bench("import cm-lib (module graph)", ["-e", "await import('./cursor/hooks/cm-lib.mjs')"]);
bench("full hook: cm-pre-tool (Shell)", [hook], PAYLOAD);

// One instrumented run: the stage breakdown explains the gap between the floor
// and the full hook, which is the only part of this that ContextMind controls.
const instrumented = spawnSync(process.execPath, [hook], {
	input: PAYLOAD,
	encoding: "utf8",
	windowsHide: true,
	cwd: ROOT,
	env: { ...process.env, CONTEXTMIND_TIMING: "1" },
});
if (instrumented.stderr?.trim()) {
	console.log("\nstage breakdown (one instrumented run):");
	for (const line of instrumented.stderr.trim().split("\n")) console.log(`  ${line.trim()}`);
} else {
	console.log("\n(no stage breakdown emitted — set CONTEXTMIND_TIMING=1 in the hook environment)");
}
