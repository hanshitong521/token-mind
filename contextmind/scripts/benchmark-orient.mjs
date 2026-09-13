#!/usr/bin/env node
/**
 * Orient latency before/after report. Writes JSON to stdout and project file.
 * Usage: node scripts/benchmark-orient.mjs [projectRoot]
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "../lib/config.mjs";
import { openRuntime } from "../lib/runtime.mjs";
import { callTool } from "../lib/mcp-tools.mjs";
import { buildLegacyBrokenCodegraphCommand, probeCodegraphSpawn } from "../lib/codegraph-spawn.mjs";
import { codegraphBin } from "../lib/bin-probe.mjs";

const projectRoot = resolve(process.argv[2] ?? process.cwd());
const symbol = "OceanMikuController";
const cfg = loadConfig(projectRoot);
const bin = codegraphBin(cfg);

const report = {
	projectRoot,
	symbol,
	timestamp: new Date().toISOString(),
	platform: process.platform,
	codegraphBin: bin,
	rows: [],
};

function push(name, ms, data) {
	report.rows.push({ name, ms, ...data });
}

if (process.platform === "win32" && /\.ps1$/i.test(String(bin))) {
	const t0 = Date.now();
	const { cmd } = buildLegacyBrokenCodegraphCommand(bin, ["node", symbol]);
	const res = spawnSync(cmd, { shell: true, cwd: projectRoot, encoding: "utf8", timeout: 12_000 });
	const ms = Date.now() - t0;
	const bytes = Buffer.byteLength(res.stdout ?? "", "utf8");
	push("legacy_cmd_ps1_node", ms, {
		ok: false,
		timedOut: res.error?.code === "ETIMEDOUT" || res.status === null,
		exitCode: res.status,
		stdoutBytes: bytes,
		note: "pre-fix: cmd.exe + bare .ps1",
	});
}

{
	const t0 = Date.now();
	const p = probeCodegraphSpawn({ ...cfg, project_root: projectRoot }, { symbol, timeoutMs: 25_000 });
	push("probe_powershell_ps1_node", Date.now() - t0, { ok: p.ok, launcher: p.launcher, stdoutBytes: p.stdoutBytes, detail: p.detail });
}

{
	const rt = openRuntime(projectRoot);
	rt.cfg = {
		...rt.cfg,
		project_root: projectRoot,
		adapters: { ...rt.cfg.adapters, codegraph: { ...rt.cfg.adapters?.codegraph, orient_mode: "auto" } },
	};
	const t0 = Date.now();
	const res = await callTool("context_orient", { query: symbol, refresh: true }, rt);
	const text = res.content[0]?.text ?? "";
	push("orient_auto_fast_path", Date.now() - t0, {
		ok: /orient_path=fast/.test(text),
		head: text.split("\n")[0],
	});
	rt.close();
}

{
	const rt = openRuntime(projectRoot);
	rt.cfg = {
		...rt.cfg,
		project_root: projectRoot,
		adapters: { ...rt.cfg.adapters, codegraph: { ...rt.cfg.adapters?.codegraph, orient_mode: "explore" } },
	};
	const t0 = Date.now();
	const res = await callTool("context_orient", { query: symbol, refresh: true }, rt);
	const text = res.content[0]?.text ?? "";
	push("orient_explore_full", Date.now() - t0, {
		ok: /orient_path=explore/.test(text),
		head: text.split("\n")[0],
	});
	rt.close();
}

const outPath = resolve(projectRoot, "orient-benchmark-latest.json");
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
