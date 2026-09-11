/**
 * Shell first-layer owner.
 *
 * Locked to `cc_balanced` by bench/shell_owner_retest.md and
 * docs/evidence/SHELL_FIRST_LAYER_AB.md: with the wrap path actually feeding
 * `--cmd` through, the engine saved 97.4% while keeping the pytest assertion
 * and passthrough-ing a 623-token stack trace, where `rtk err` reported
 * "[ok] Command completed successfully (no errors)" and dropped the whole
 * stack. RTK is therefore not reachable from this code path at all — there is
 * no flag to turn it back on, only the config lock and this comment.
 *
 * ## Two transports, one compressor
 *
 * The compressor is `context-compress`'s `compressOutput()`. There are two ways
 * to reach it and they produce the same bytes:
 *
 *   - **in-process** (default) — `require()` the ESM module once, call the
 *     function directly. Measured on this Windows box: p50 **2.8 ms**.
 *   - **CLI** (`CONTEXTMIND_ENGINE_INPROC=0`) — `spawnSync(node, [cli, filter])`,
 *     one fresh Node process per payload. Measured p50 **583–1443 ms**.
 *
 * The spawn was originally the only path, on the argument that "the invocation
 * is the CLI, the same one the A/B measured, so numbers stay comparable". That
 * argument holds for *benchmarks* and fails for *production*: a 500 ms+ tax on
 * every oversized tool output is the single largest latency item in the hook
 * (the gate's own logic is <1.5 ms end-to-end). The A/B measured a compression
 * *ratio*, and the ratio is unchanged — `compressOutput` is the same function,
 * verified byte-identical apart from one trailing newline the CLI appends and
 * the gate trims anyway. So the CLI path is kept, reachable by flag, for anyone
 * re-running the original baseline; production takes the fast path.
 *
 * Fail-open either way: any load/spawn error returns `ok: false` and the caller
 * falls through with the raw text (spec P5 — a failed compressor may not emit a
 * partial summary).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ENGINE_ROOT } from "./config.mjs";

/** Absolute path to the engine CLI, or null when the engine is not built. */
export function engineCliPath() {
	const candidate = join(ENGINE_ROOT, "dist", "cli", "index.js");
	return existsSync(candidate) ? candidate : null;
}

/** Absolute path to the engine's library entry, or null when not built. */
export function engineLibPath() {
	const candidate = join(ENGINE_ROOT, "dist", "cli", "filter.js");
	return existsSync(candidate) ? candidate : null;
}

/**
 * Whether the in-process transport is enabled. Set `CONTEXTMIND_ENGINE_INPROC=0`
 * to force the CLI path (needed only to reproduce the pre-2026-09-10 baseline).
 */
function inprocEnabled() {
	const v = process.env.CONTEXTMIND_ENGINE_INPROC;
	return v !== "0" && v !== "false" && v !== "off";
}

// Cached module handle. `undefined` = not tried yet; `null` = tried, unavailable.
let inprocModule;

/**
 * Load the engine library once per process.
 *
 * `require()` of an ESM module is synchronous on Node >=22.12 (no top-level
 * await in the engine), which is what lets a synchronous `compress()` use it.
 * A cold load costs ~115 ms — paid once, and only when a payload actually needs
 * compressing, so passthrough and dedup paths never pay it.
 */
function loadInproc() {
	if (inprocModule !== undefined) return inprocModule;
	inprocModule = null;
	if (!inprocEnabled()) return inprocModule;
	const lib = engineLibPath();
	if (!lib) return inprocModule;
	try {
		const require = createRequire(import.meta.url);
		const mod = require(lib);
		if (typeof mod?.compressOutput === "function") inprocModule = mod;
	} catch {
		inprocModule = null; // fall through to the CLI path
	}
	return inprocModule;
}

/**
 * Run the engine's `filter` on already-captured output.
 *
 * @returns {{output: string, ok: boolean, latencyMs: number, error?: string}}
 *   `ok: false` means the caller must fall through with the raw text — a
 *   compressor that failed is not allowed to emit a partial summary (spec P5).
 */
export function compress(stdout, cmd, { mode = "balanced", timeoutMs = 20_000 } = {}) {
	const ip = loadInproc();
	if (ip) {
		const started = performance.now();
		try {
			const output = ip.compressOutput(stdout, cmd ?? "", mode);
			return { output, ok: true, latencyMs: performance.now() - started };
		} catch (err) {
			return {
				output: stdout,
				ok: false,
				latencyMs: performance.now() - started,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	const cli = engineCliPath();
	if (!cli) {
		return { output: stdout, ok: false, latencyMs: 0, error: "engine CLI not built" };
	}

	const args = [cli, "filter", "--mode", mode];
	if (cmd) args.push("--cmd", cmd);

	const started = performance.now();
	let res;
	try {
		res = spawnSync(process.execPath, args, {
			input: Buffer.from(stdout, "utf8"),
			maxBuffer: 256 * 1024 * 1024,
			timeout: timeoutMs,
			windowsHide: true,
		});
	} catch (err) {
		return {
			output: stdout,
			ok: false,
			latencyMs: performance.now() - started,
			error: err instanceof Error ? err.message : String(err),
		};
	}
	const latencyMs = performance.now() - started;

	if (res.error) return { output: stdout, ok: false, latencyMs, error: String(res.error) };
	if (res.status !== 0) {
		const stderr = res.stderr?.toString("utf8")?.trim();
		return { output: stdout, ok: false, latencyMs, error: stderr || `exit ${res.status}` };
	}
	return { output: res.stdout.toString("utf8"), ok: true, latencyMs };
}

/**
 * Whether the engine is installed and usable. Reported by doctor rather than
 * discovered at the first tool call, where a missing engine would show up as
 * "compression did nothing".
 */
export function engineStatus() {
	const lib = engineLibPath();
	const inproc = inprocEnabled() && lib !== null;
	if (inproc) {
		return {
			ok: true,
			transport: "in-process",
			version: null,
			cli: lib,
		};
	}
	const cli = engineCliPath();
	if (!cli) return { ok: false, reason: "dist/cli/index.js missing — run `npm run build` in context-compress-main" };
	const res = spawnSync(process.execPath, [cli, "--version"], { timeout: 10_000, windowsHide: true });
	if (res.error) return { ok: false, reason: String(res.error) };
	if (res.status !== 0) return { ok: false, reason: `exit ${res.status}: ${res.stderr?.toString("utf8")?.trim() ?? ""}` };
	return { ok: true, transport: "cli", version: res.stdout.toString("utf8").trim(), cli };
}
