import { nowSec } from "./ttl-policy.mjs";

/** Drop bundles/tool rows tied to an old dependency fingerprint (spec §13). */
export function invalidateByDependency(db, current_fp) {
	if (!db || !current_fp) return { context: 0, tool: 0 };
	let context = 0;
	let tool = 0;
	try {
		context =
			db.prepare(`DELETE FROM context_cache WHERE dependency_fp IS NOT NULL AND dependency_fp != ?`).run(current_fp)
				.changes ?? 0;
		tool =
			db.prepare(`DELETE FROM tool_cache WHERE dependency_fp IS NOT NULL AND dependency_fp != ?`).run(current_fp)
				.changes ?? 0;
	} catch {
		/* fail-open */
	}
	return { context, tool };
}

export function purgeExpired(db) {
	if (!db) return 0;
	const now = nowSec();
	let n = 0;
	for (const table of ["prompt_cache", "context_cache", "tool_cache", "output_cache", "semantic_cache"]) {
		try {
			n += db.prepare(`DELETE FROM ${table} WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(now).changes ?? 0;
		} catch {
			/* skip */
		}
	}
	return n;
}

export function isFingerprintStale(stored, current) {
	if (!stored || !current) return false;
	return stored !== current;
}
