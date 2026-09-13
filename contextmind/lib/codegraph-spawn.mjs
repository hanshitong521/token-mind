/**
 * CodeGraph CLI spawn (bundled-direct preferred over powershell .ps1).
 *
 * AI-NOTE:
 * - Prefer resolveBundledLaunch; .ps1 is last resort (hang doc cold path).
 * - Doctor uses probeCodegraphSpawn only when sidecar probe fails.
 * - AFTER CHANGE: with sidecar down, launcher must be `bundled-direct` not `cmd-ps1-broken`.
 */

import { spawn, spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import { codegraphBin } from "./bin-probe.mjs";
import { resolveBundledLaunch } from "./codegraph-direct.mjs";

const SHELL_UNSAFE = /["&|<>^%!`\n\r]/;

function shellSafe(value) {
	const s = String(value);
	if (SHELL_UNSAFE.test(s)) {
		throw new Error(`rejected characters in argument: ${JSON.stringify(s.slice(0, 60))}`);
	}
	return s;
}

export function codegraphCwd(cfg) {
	const root = cfg?.project_root ?? process.cwd();
	return isAbsolute(root) ? root : resolve(process.cwd(), root);
}

/** @returns {{ launcher: string, cmd?: string, exec?: { file: string, args: string[] } }} */
export function buildCodegraphCommand(bin, args, cfg) {
	const safeArgs = args.map(shellSafe);
	const bundled = cfg ? resolveBundledLaunch(cfg) : null;
	if (bundled) {
		return {
			launcher: bundled.launcher,
			exec: { file: bundled.node, args: [bundled.entry, ...safeArgs] },
		};
	}
	if (process.platform === "win32" && /\.ps1$/i.test(bin)) {
		const ps1 = bin.replace(/"/g, "");
		return {
			launcher: "powershell-ps1",
			cmd: `powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}" ${safeArgs.join(" ")}`,
		};
	}
	return { launcher: "direct", cmd: [bin, ...safeArgs].join(" ") };
}

function spawnCodegraph(cfg, args, opts) {
	const bin = opts.binOverride ?? codegraphBin(cfg);
	const built = buildCodegraphCommand(bin, args, cfg);
	const cwd = codegraphCwd(cfg);
	const common = {
		cwd,
		encoding: "utf8",
		windowsHide: true,
		...opts.spawnOpts,
	};
	if (built.exec) {
		return spawnSync(built.exec.file, built.exec.args, { ...common, shell: false, ...opts.syncOpts });
	}
	return spawnSync(built.cmd, { ...common, shell: true, ...opts.syncOpts });
}

/** Legacy broken path on Windows: cmd.exe + bare .ps1 (hangs until timeout). */
export function buildLegacyBrokenCodegraphCommand(bin, args) {
	const safeArgs = args.map(shellSafe);
	return { launcher: "cmd-ps1-broken", cmd: [bin, ...safeArgs].join(" ") };
}

export function runCodegraphSync(cfg, args, { timeoutMs = 120_000, binOverride } = {}) {
	return spawnCodegraph(cfg, args, {
		binOverride,
		syncOpts: { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
	});
}

/** Parallel-friendly spawn (callers + callees in orient fast path). */
export function runCodegraphAsync(cfg, args, { timeoutMs = 120_000, binOverride } = {}) {
	const bin = binOverride ?? codegraphBin(cfg);
	if (!bin) {
		return Promise.resolve({ status: 1, stdout: "", stderr: "no codegraph bin" });
	}
	const built = buildCodegraphCommand(bin, args, cfg);
	const cwd = codegraphCwd(cfg);
	return new Promise((resolve) => {
		const child = built.exec
			? spawn(built.exec.file, built.exec.args, { cwd, windowsHide: true, shell: false })
			: spawn(built.cmd, { shell: true, cwd, windowsHide: true });
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (d) => {
			stdout += d;
		});
		child.stderr?.on("data", (d) => {
			stderr += d;
		});
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* ok */
			}
			resolve({ status: null, stdout, stderr: `${stderr}\n[timeout ${timeoutMs}ms]`.trim(), error: { code: "ETIMEDOUT" } });
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ status: 1, stdout, stderr: err?.message ?? String(err) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ status: code, stdout, stderr });
		});
	});
}

/**
 * Smoke probe: `codegraph node <symbol>` must finish quickly when index exists.
 * @returns {{ ok: boolean, ms: number, launcher: string, exitCode: number|null, stdoutBytes: number, detail: string }}
 */
export function probeCodegraphSpawn(cfg, { symbol = "OceanMikuController", timeoutMs = 20_000 } = {}) {
	const bin = codegraphBin(cfg);
	if (!bin) {
		return { ok: false, ms: 0, launcher: "none", exitCode: null, stdoutBytes: 0, detail: "no codegraph bin" };
	}
	const built = buildCodegraphCommand(bin, ["node", symbol], cfg);
	const t0 = Date.now();
	const res = spawnCodegraph(cfg, ["node", symbol], {
		syncOpts: { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
	});
	const ms = Date.now() - t0;
	const launcher = built.launcher;
	const stdoutBytes = Buffer.byteLength(res.stdout ?? "", "utf8");
	const exitCode = res.status;
	const timedOut = res.error?.code === "ETIMEDOUT" || (exitCode === null && ms >= timeoutMs - 50);
	const ok = !timedOut && exitCode === 0 && stdoutBytes > 80;
	let detail = ok ? `${ms}ms ${launcher}` : timedOut ? `timeout ${timeoutMs}ms (${launcher})` : `exit=${exitCode} ${ms}ms`;
	if (!ok && process.platform === "win32" && /\.ps1$/i.test(bin) && launcher !== "powershell-ps1") {
		detail += " — use PowerShell -File for .ps1";
	}
	return { ok, ms, launcher, exitCode, stdoutBytes, detail };
}

export const _test = { shellSafe, buildLegacyBrokenCodegraphCommand };
