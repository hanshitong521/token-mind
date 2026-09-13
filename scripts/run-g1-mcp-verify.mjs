#!/usr/bin/env node
/**
 * G1 MCP verify — contextmind tools + brain HTTP + hooks (VERIFY A4 stdio).
 *   node scripts/run-g1-mcp-verify.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT = join(ROOT, ".agent");
const OUT = join(AGENT, "g1-mcp-verify-last.json");
const CMHOOK = join(ROOT, ".cursor/hooks/cmhook.exe");
const BRAIN_MCP_URL = (process.env.BRAIN_MCP_URL || "http://127.0.0.1:18788/mcp").replace(/\/$/, "");

function readJson(path) {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function ctxFromG0Snapshot() {
	const g0 = readJson(join(AGENT, "g0-session-snapshot-last.json"));
	const ctx = g0?.session_tools_stdio?.contextmind;
	if (!g0?.ok || !ctx?.ok) return null;
	const age = Date.now() - new Date(g0.at).getTime();
	if (age > 10 * 60 * 1000) return null;
	return { ok: true, count: ctx.tools, ms: ctx.ms, via: "g0-session-snapshot" };
}

function ctxFromProbe() {
	const res = spawnSync(process.execPath, [join(ROOT, "scripts/mcp-stdio-probe.mjs")], {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 60_000,
		windowsHide: true,
	});
	let data = null;
	try {
		data = JSON.parse((res.stdout || "").trim());
	} catch {
		return { ok: false, err: "probe parse failed", stderr: (res.stderr || "").slice(-300) };
	}
	const ctx = data?.contextmind;
	return {
		ok: ctx?.ok === true,
		count: ctx?.tools ?? 0,
		ms: ctx?.ms,
		via: "mcp-stdio-probe.mjs",
	};
}

function brainHealth() {
	return new Promise((resolve) => {
		const req = http.get("http://127.0.0.1:18788/health", { timeout: 3000 }, (res) => {
			res.resume();
			resolve({ ok: res.statusCode === 200, url: BRAIN_MCP_URL });
		});
		req.on("error", (e) => resolve({ ok: false, err: e.message }));
		req.setTimeout(3000, () => {
			req.destroy();
			resolve({ ok: false, err: "timeout" });
		});
	});
}

const ctx = ctxFromG0Snapshot() ?? ctxFromProbe();
const brain = await brainHealth();
const hooksJson = existsSync(join(ROOT, ".cursor/hooks.json"));
let hookEntries = 0;
if (hooksJson) {
	try {
		const h = JSON.parse(readFileSync(join(ROOT, ".cursor/hooks.json"), "utf8"));
		hookEntries = Object.values(h.hooks || h).flat().length;
	} catch {
		hookEntries = 0;
	}
}

const checks = {
	contextmind_tools: ctx.ok && ctx.count >= 6,
	brain_http: brain.ok,
	cmhook: existsSync(CMHOOK),
	hooks_json: hooksJson && hookEntries >= 4,
};
const ok = Object.values(checks).every(Boolean);

const rec = {
	at: new Date().toISOString(),
	gate_id: "G1",
	ok,
	checks,
	contextmind: ctx,
	brain,
	hook_entries: hookEntries,
	note: "stdio probe + brain HTTP; Cursor UI visibility still manual",
};

mkdirSync(AGENT, { recursive: true });
writeFileSync(OUT, `${JSON.stringify(rec, null, 2)}\n`);
console.log(`g1 mcp verify: ${ok ? "PASS" : "FAIL"}`);
if (!ok) {
	for (const [k, v] of Object.entries(checks)) {
		if (!v) console.log(`  FAIL ${k}`);
	}
}
process.exit(ok ? 0 : 1);
