/**
 * CodeGraph graph freshness for orient ResultCache (S5).
 * Key includes max mtime of `.codegraph/*` so index rebuild invalidates cache.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const WATCH = ["daemon.pid", "graph.db", "index.db", "meta.json", "graph.json"];

export function codegraphGraphFp(projectRoot) {
	if (!projectRoot) return "na";
	const dir = join(resolve(projectRoot), ".codegraph");
	if (!existsSync(dir)) return "missing";
	let max = 0;
	for (const name of WATCH) {
		const p = join(dir, name);
		if (!existsSync(p)) continue;
		try {
			max = Math.max(max, statSync(p).mtimeMs);
		} catch {
			/* skip */
		}
	}
	if (max === 0) {
		try {
			for (const ent of readdirSync(dir, { withFileTypes: true })) {
				if (!ent.isFile()) continue;
				max = Math.max(max, statSync(join(dir, ent.name)).mtimeMs);
			}
		} catch {
			/* skip */
		}
	}
	return max ? String(Math.floor(max)) : "empty";
}
