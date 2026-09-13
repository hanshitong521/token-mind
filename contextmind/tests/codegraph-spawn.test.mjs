import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildCodegraphCommand,
	buildLegacyBrokenCodegraphCommand,
	probeCodegraphSpawn,
} from "../lib/codegraph-spawn.mjs";
import { loadConfigFrom } from "../lib/config.mjs";

describe("codegraph-spawn", () => {
	it("uses PowerShell -File for .ps1 on Windows", () => {
		if (process.platform !== "win32") return;
		const { launcher, cmd } = buildCodegraphCommand("D:/bun/codegraph.ps1", ["node", "Foo"]);
		assert.equal(launcher, "powershell-ps1");
		assert.match(cmd, /powershell -NoProfile -ExecutionPolicy Bypass -File/i);
		assert.match(cmd, /codegraph\.ps1/i);
		assert.match(cmd, /node Foo/);
	});

	it("legacy cmd+ps1 path times out or returns no output (regression guard)", () => {
		if (process.platform !== "win32") return;
		const cfg = loadConfigFrom(null, process.cwd());
		const bin = cfg.adapters?.codegraph?.bin;
		if (!bin || !/\.ps1$/i.test(bin)) return;
		const { cmd } = buildLegacyBrokenCodegraphCommand(bin, ["node", "OceanMikuController"]);
		const t0 = Date.now();
		const res = spawnSync(cmd, {
			shell: true,
			cwd: process.cwd(),
			encoding: "utf8",
			timeout: 8_000,
		});
		const ms = Date.now() - t0;
		const bytes = Buffer.byteLength(res.stdout ?? "", "utf8");
		assert.ok(ms >= 7_000 || bytes < 80, `expected hang/empty legacy spawn, got ${ms}ms ${bytes}B`);
	});

	it("probe finishes under budget when codegraph installed", () => {
		const cfg = loadConfigFrom(null, process.cwd());
		const bin = cfg.adapters?.codegraph?.bin;
		if (!bin) return;
		const probe = probeCodegraphSpawn({ ...cfg, project_root: process.cwd() }, { timeoutMs: 25_000 });
		assert.equal(probe.ok, true, probe.detail);
		assert.ok(probe.ms < 20_000, `probe too slow: ${probe.ms}ms`);
	});
});
