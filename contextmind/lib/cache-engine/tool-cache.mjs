import { nowSec, tierForHits, ttlSecondsForTier } from "./ttl-policy.mjs";

export class ToolCache {
	constructor(db, opts = {}) {
		this.db = db;
		this.baseTtl = opts.ttl_sec ?? 600;
	}

	get(cacheKey, dependency_fp) {
		if (!this.db || !cacheKey) return null;
		const now = nowSec();
		try {
			const row = this.db
				.prepare(
					`SELECT output_ref, dependency_fp, hit_count FROM tool_cache
					 WHERE cache_key = ? AND (expires_at IS NULL OR expires_at > ?)`,
				)
				.get(cacheKey, now);
			if (!row) return null;
			if (dependency_fp && row.dependency_fp && row.dependency_fp !== dependency_fp) {
				return { stale: true };
			}
			this.db
				.prepare(`UPDATE tool_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE cache_key = ?`)
				.run(now, cacheKey);
			return { output_ref: row.output_ref, hit_count: row.hit_count + 1 };
		} catch {
			return null;
		}
	}

	put({ cache_key, project_id, tool_name, args_hash, output_ref, dependency_fp, admission }) {
		if (!this.db || !cache_key || !output_ref) return false;
		if (admission === "REJECT") return false;
		const now = nowSec();
		const exp = now + ttlSecondsForTier("temporary", this.baseTtl);
		try {
			this.db
				.prepare(
					`INSERT INTO tool_cache(cache_key, project_id, tool_name, args_hash, output_ref, dependency_fp,
					 hit_count, created_at, last_hit_at, expires_at, tier)
					 VALUES(?,?,?,?,?,?,0,?,?,?,'temporary')
					 ON CONFLICT(cache_key) DO UPDATE SET output_ref=excluded.output_ref, expires_at=excluded.expires_at`,
				)
				.run(cache_key, project_id, tool_name, args_hash, output_ref, dependency_fp ?? "", now, now, exp);
			return true;
		} catch {
			return false;
		}
	}
}
