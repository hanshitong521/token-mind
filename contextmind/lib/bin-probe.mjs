/**
 * Shared binary-resolution helpers.
 *
 * `commandAvailable` decides availability by resolving PATH ourselves rather
 * than shelling out: a `shell:true` spawn of a missing `.cmd` on Windows exits
 * 1 with localized stderr, indistinguishable from "ran and failed" — so the
 * ADAPTER_MISSING vs NO_INDEX statuses must never depend on console language.
 *
 * Both the MCP tool layer (mcp-tools.mjs) and the sessionStart adapter probe
 * (probe.mjs) need this, so it lives here to keep the two copies from drifting.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export function codegraphBin(cfg) {
	return cfg?.adapters?.codegraph?.bin ?? "codegraph";
}

/**
 * Cache keyed on the PATH/PATHEXT it was resolved under, so a caller that
 * mutates the environment between calls (tests do) never reads a stale answer.
 */
const commandCache = new Map();

export function commandAvailable(bin) {
	const key = `${bin}\u0000${process.env.PATH ?? ""}\u0000${process.env.PATHEXT ?? ""}`;
	if (commandCache.has(key)) return commandCache.get(key);
	let ok = false;
	try {
		if (bin.includes("/") || bin.includes("\\")) {
			ok = existsSync(bin);
		} else {
			const win = process.platform === "win32";
			const exts = win ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
			for (const dir of (process.env.PATH ?? "").split(win ? ";" : ":")) {
				if (!dir) continue;
				for (const ext of exts) {
					try {
						if (statSync(join(dir, bin + ext)).isFile()) {
							ok = true;
							break;
						}
					} catch {
						/* not this dir */
					}
				}
				if (ok) break;
			}
		}
	} catch {
		ok = false;
	}
	commandCache.set(key, ok);
	return ok;
}
