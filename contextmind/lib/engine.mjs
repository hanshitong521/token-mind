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
 * The invocation is the CLI, the same one the A/B measured, so numbers stay
 * comparable. An in-process import would be faster and would silently
 * invalidate the baseline.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_ROOT } from "./config.mjs";

/** Absolute path to the engine CLI, or null when the engine is not built. */
export function engineCliPath() {
	const candidate = join(ENGINE_ROOT, "dist", "cli", "index.js");
	return existsSync(candidate) ? candidate : null;
}

/**
 * Run the engine's `filter` on already-captured output.
 *
 * @returns {{output: string, ok: boolean, latencyMs: number, error?: string}}
 *   `ok: false` means the caller must fall through with the raw text — a
 *   compressor that failed is not allowed to emit a partial summary (spec P5).
 */
export function compress(stdout, cmd, { mode = "balanced", timeoutMs = 20_000 } = {}) {
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
	const cli = engineCliPath();
	if (!cli) return { ok: false, reason: "dist/cli/index.js missing — run `npm run build` in context-compress-main" };
	const res = spawnSync(process.execPath, [cli, "--version"], { timeout: 10_000, windowsHide: true });
	if (res.error) return { ok: false, reason: String(res.error) };
	if (res.status !== 0) return { ok: false, reason: `exit ${res.status}: ${res.stderr?.toString("utf8")?.trim() ?? ""}` };
	return { ok: true, version: res.stdout.toString("utf8").trim(), cli };
}
