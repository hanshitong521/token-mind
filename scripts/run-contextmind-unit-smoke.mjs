#!/usr/bin/env node
/**
 * Peak-relevant ContextMind unit tests (excludes prompt-lab slow suite).
 *   node scripts/run-contextmind-unit-smoke.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CM = join(ROOT, ".cursor", "contextmind");
const OUT = join(ROOT, ".agent", "contextmind-unit-smoke-last.json");

const FILES = [
	"tests/fast-allow-pre.test.mjs",
	"tests/hooks.test.mjs",
	"tests/cache-engine.test.mjs",
	"tests/lib.test.mjs",
	"tests/mcp.test.mjs",
	"tests/stack-peak.test.mjs",
	"tests/codegraph-spawn.test.mjs",
	"tests/symbols.test.mjs",
	"tests/outline.test.mjs",
].map((f) => join(CM, f));

const CLI = join(ROOT, ".cursor", "contextmind", "cli.mjs");
spawnSync(process.execPath, [CLI, "doctor", ROOT], {
	cwd: ROOT,
	encoding: "utf8",
	timeout: 90_000,
	windowsHide: true,
});

function runTests() {
	return spawnSync(process.execPath, ["--test", ...FILES], {
		cwd: CM,
		encoding: "utf8",
		timeout: 180_000,
		windowsHide: true,
	});
}

const t0 = performance.now();
let r = runTests();
if (r.status !== 0) {
	spawnSync(process.execPath, [CLI, "doctor", ROOT], { cwd: ROOT, encoding: "utf8", timeout: 90_000, windowsHide: true });
	r = runTests();
}
const out = `${r.stdout || ""}${r.stderr || ""}`;
const pass = Number((out.match(/ℹ pass (\d+)/) || [])[1]) || 0;
const fail = Number((out.match(/ℹ fail (\d+)/) || [])[1]) || 0;
const tests = Number((out.match(/ℹ tests (\d+)/) || [])[1]) || 0;
const rec = {
	at: new Date().toISOString(),
	ok: r.status === 0 && fail === 0,
	exit: r.status,
	pass,
	fail,
	tests,
	duration_ms: Math.round(performance.now() - t0),
	files: FILES.length,
	tail: out.trim().split("\n").slice(-8),
};

if (!existsSync(join(ROOT, ".agent"))) mkdirSync(join(ROOT, ".agent"), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(rec, null, 2)}\n`);

console.log(`contextmind unit smoke: ${rec.ok ? "PASS" : "FAIL"} ${pass}/${tests} (${rec.duration_ms}ms)`);
if (!rec.ok) console.log(out.slice(-2000));
process.exit(rec.ok ? 0 : 1);
