/**
 * Resolve CodeGraph node.exe + entry without powershell / npm-shim.
 *
 * AI-NOTE:
 * - WHY: ps1→shim→bundled node multiplies cold start. Direct exec is the CLI fallback.
 * - Layout drifts: 1.6+ uses `.../codegraph/dist/bin/codegraph.js`; older nests
 *   `codegraph-win32-x64` under package or `@colbymchenry/.codegraph-*`.
 * - Prefer CONTEXTMIND_NODE / D:\\nodejs\\node.exe over PATH `nodejs_wheel`.
 * - AFTER CHANGE TEST: resolveBundledLaunch(cfg) non-null for D:/bun/codegraph.ps1;
 *   doctor must not regress to `powershell-ps1` when sidecar is down.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { codegraphBin } from "./bin-probe.mjs";

function preferNode(candidates) {
	for (const n of candidates) {
		if (n && existsSync(n)) return n;
	}
	return process.execPath;
}

function findPlatformBundle(shimRoot) {
	const nested = join(shimRoot, "node_modules", "@colbymchenry", `codegraph-${process.platform}-${process.arch}`);
	if (existsSync(join(nested, "node.exe")) && existsSync(join(nested, "lib", "dist", "bin", "codegraph.js"))) {
		return {
			node: join(nested, "node.exe"),
			entry: join(nested, "lib", "dist", "bin", "codegraph.js"),
		};
	}
	// bun/npm may park the optional platform package under @colbymchenry/.codegraph-*
	const parent = dirname(shimRoot);
	try {
		for (const name of readdirSync(parent)) {
			if (!name.startsWith(".codegraph")) continue;
			const bundle = join(parent, name, "node_modules", "@colbymchenry", `codegraph-${process.platform}-${process.arch}`);
			const node = join(bundle, "node.exe");
			const entry = join(bundle, "lib", "dist", "bin", "codegraph.js");
			if (existsSync(node) && existsSync(entry)) return { node, entry };
		}
	} catch {
		/* ok */
	}
	return null;
}

/** @returns {{ node: string, entry: string, launcher: "bundled-direct" } | null} */
export function resolveBundledLaunch(cfg) {
	const cg = cfg?.adapters?.codegraph ?? {};
	if (cg.bundled_node && cg.bundled_entry && existsSync(cg.bundled_node) && existsSync(cg.bundled_entry)) {
		return { node: cg.bundled_node, entry: cg.bundled_entry, launcher: "bundled-direct" };
	}

	const bin = codegraphBin(cfg);
	const base = /\.ps1$/i.test(bin) || bin.includes("/") || bin.includes("\\") ? dirname(bin) : null;
	const shimRoot = base ? join(base, "node_modules", "@colbymchenry", "codegraph") : null;

	// 1.6+ layout: package dist/bin (what codegraph.ps1 now invokes)
	if (shimRoot) {
		const distEntry = join(shimRoot, "dist", "bin", "codegraph.js");
		if (existsSync(distEntry)) {
			const platform = findPlatformBundle(shimRoot);
			const node = preferNode([
				platform?.node,
				base ? join(base, "node.exe") : null,
				process.env.CONTEXTMIND_NODE,
				"D:\\nodejs\\node.exe",
			]);
			return { node, entry: distEntry, launcher: "bundled-direct" };
		}
		const platform = findPlatformBundle(shimRoot);
		if (platform) return { ...platform, launcher: "bundled-direct" };
	}

	return null;
}
