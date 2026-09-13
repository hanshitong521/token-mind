#!/usr/bin/env node
/**
 * G7 install → uninstall E2E in temp dir (cli.test.mjs).
 *   node scripts/run-install-uninstall-e2e.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CM = join(ROOT, ".cursor", "contextmind");
const OUT = join(ROOT, ".agent", "install-uninstall-e2e-last.json");

const t0 = performance.now();
const r = spawnSync(process.execPath, ["--test", join(CM, "tests/cli.test.mjs")], {
	cwd: CM,
	encoding: "utf8",
	timeout: 180_000,
	windowsHide: true,
});
const out = `${r.stdout || ""}${r.stderr || ""}`;
const pass = Number((out.match(/ℹ pass (\d+)/) || [])[1]) || 0;
const fail = Number((out.match(/ℹ fail (\d+)/) || [])[1]) || 0;
const rec = {
	at: new Date().toISOString(),
	ok: r.status === 0 && fail === 0,
	exit: r.status,
	pass,
	fail,
	duration_ms: Math.round(performance.now() - t0),
	tail: out.trim().split("\n").slice(-8),
};

if (!existsSync(join(ROOT, ".agent"))) mkdirSync(join(ROOT, ".agent"), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(rec, null, 2)}\n`);

console.log(`install-uninstall e2e: ${rec.ok ? "PASS" : "FAIL"} ${pass} tests (${rec.duration_ms}ms)`);
if (!rec.ok) console.log(out.slice(-2500));
process.exit(rec.ok ? 0 : 1);
