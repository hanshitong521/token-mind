#!/usr/bin/env node
/**
 * G3 token evidence — orient benches + task-level −40%.
 *   node scripts/run-g3-token-evidence.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(ROOT, "scripts");

function run(script) {
	const r = spawnSync(process.execPath, [join(SCRIPTS, script)], {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 120_000,
		windowsHide: true,
	});
	if (r.status !== 0) {
		console.error((r.stderr || r.stdout || "").slice(-1500));
		return false;
	}
	return true;
}

for (const s of ["orient-dup-bench.mjs", "orient-cache-bench.mjs", "task-token-savings.mjs", "g3-shell-mcp-bench.mjs"]) {
	if (!run(s)) process.exit(1);
}

const task = JSON.parse(readFileSync(join(ROOT, ".agent/task-token-savings-last.json"), "utf8"));
const shellMcp = JSON.parse(readFileSync(join(ROOT, ".agent/g3-shell-mcp-bench-last.json"), "utf8"));
const pass = task.gate_g3_task_level_minus_40 === "PASS" && shellMcp.ok;
console.log(
	`g3 token evidence: ${pass ? "PASS" : "FAIL"} task=${(task.saved_ratio * 100).toFixed(1)}% shell=${(shellMcp.shell.saved_ratio * 100).toFixed(1)}%`,
);
process.exit(pass ? 0 : 1);
