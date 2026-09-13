#!/usr/bin/env node
/**
 * Ensure Brain + ContextMind runtime + CodeGraph sidecar before smoke.
 *   node scripts/ensure-agent-stack-deps.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, ".cursor", "contextmind", "cli.mjs");
const BRAIN_START =
	process.env.BRAIN_START_SCRIPT ||
	"E:\\workA\\A-skill\\A-github-skill-mcp\\project-brain-agent\\scripts\\start-dashboard-background.ps1";

function httpOk(url, timeoutMs = 3000) {
	return new Promise((resolve) => {
		const req = http.get(url, { timeout: timeoutMs }, (res) => {
			res.resume();
			resolve(res.statusCode === 200);
		});
		req.on("error", () => resolve(false));
		req.setTimeout(timeoutMs, () => {
			req.destroy();
			resolve(false);
		});
	});
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

const checks = { runtime: false, brain: false, sidecar: false };

spawnSync(process.execPath, [CLI, "start", ROOT], {
	cwd: ROOT,
	encoding: "utf8",
	timeout: 20_000,
	windowsHide: true,
});
checks.runtime = await httpOk("http://127.0.0.1:18787/health", 4000);

if (!(await httpOk("http://127.0.0.1:18788/health", 2000)) && existsSync(BRAIN_START)) {
	spawnSync(
		"powershell",
		["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BRAIN_START],
		{ cwd: ROOT, encoding: "utf8", timeout: 30_000, windowsHide: true },
	);
	for (let i = 0; i < 8 && !(await httpOk("http://127.0.0.1:18788/health", 2000)); i++) {
		await sleep(1000);
	}
}
checks.brain = await httpOk("http://127.0.0.1:18788/health", 3000);

try {
	const { loadConfig } = await import(pathToFileURL(join(ROOT, ".cursor/contextmind/lib/config.mjs")).href);
	const { getSidecarSession, probeSidecar } = await import(
		pathToFileURL(join(ROOT, ".cursor/contextmind/lib/codegraph-sidecar.mjs")).href
	);
	const cfg = { ...loadConfig(ROOT), project_root: ROOT };
	const probe = await probeSidecar(cfg, { spawnIfNeeded: true });
	if (!probe.ok) await getSidecarSession(cfg);
	checks.sidecar = (await probeSidecar(cfg, { spawnIfNeeded: false })).ok;
} catch (e) {
	console.error("sidecar:", e.message);
}

const ok = checks.runtime && checks.brain && checks.sidecar;
console.log(`ensure-agent-stack-deps: ${ok ? "PASS" : "FAIL"}`, checks);
process.exit(ok ? 0 : 1);
