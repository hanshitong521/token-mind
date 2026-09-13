#!/usr/bin/env node
/**
 * G8 consumer peak acceptance — validates smoke artifacts + g8 doc pack.
 *   node scripts/run-g8-consumer-gate.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = join(ROOT, ".agent");
const G8_DIR = join(ROOT, "docs/agent-stack/g8");
const OUT = join(AGENT, "g8-consumer-gate-last.json");

const G8_FILES = [
	"FINAL_GATE_REPORT.md",
	"TOKEN_BENCHMARK_REPORT.md",
	"CORRECTNESS_REGRESSION_REPORT.md",
	"CODE_QUALITY_AUDIT.md",
	"INSTALLATION_VALIDATION.md",
	"README.md",
];

function readJson(path) {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

const missingDocs = G8_FILES.filter((f) => !existsSync(join(G8_DIR, f)));
const peak = readJson(join(AGENT, "peak-speed-bench-last.json"));
const unit = readJson(join(AGENT, "contextmind-unit-smoke-last.json"));
const e2e = readJson(join(AGENT, "install-uninstall-e2e-last.json"));
const chain = readJson(join(AGENT, "stack-agent-chain-last.json"));
const lat = readJson(join(AGENT, "hook-latency-last.json"));
const hookP50 = lat?.cmhook_p50_ms ?? lat?.warm_hook_p50_ms;
const hookG4 =
	lat?.g4_pass === true ||
	lat?.g4_stable_pass === true ||
	lat?.g4_lite_pass === true ||
	(Number.isFinite(hookP50) && hookP50 <= 52);

const checks = {
	g8_docs: missingDocs.length === 0,
	peak_bench: peak?.rollup === "PASS",
	unit_smoke: unit?.ok === true,
	install_uninstall: e2e?.ok === true,
	agent_chain: chain?.ok === true && chain?.summary?.effect_ok === true,
	hook_g4: hookG4,
	install_artifact: existsSync(join(ROOT, ".contextmind/install-artifact.json")),
};

const ok = Object.values(checks).every(Boolean);
const rec = {
	at: new Date().toISOString(),
	ok,
	checks,
	missing_docs: missingDocs,
	note: "Peak consumer acceptance; product_complete requires G0–G3 artifacts + dod rollup",
};

if (!existsSync(AGENT)) mkdirSync(AGENT, { recursive: true });
writeFileSync(OUT, `${JSON.stringify(rec, null, 2)}\n`);

console.log(`g8 consumer gate: ${ok ? "PASS" : "FAIL"}`);
if (!ok) {
	for (const [k, v] of Object.entries(checks)) {
		if (!v) console.log(`  FAIL ${k}`);
	}
}
process.exit(ok ? 0 : 1);
