import { nowSec, tierForHits, ttlSecondsForTier } from "./ttl-policy.mjs";

export class ContextCache {
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
					`SELECT bundle_json, dependency_fp, hit_count, expires_at FROM context_cache
					 WHERE cache_key = ? AND (expires_at IS NULL OR expires_at > ?)`,
				)
				.get(cacheKey, now);
			if (!row) return null;
			if (dependency_fp && row.dependency_fp && row.dependency_fp !== dependency_fp) {
				return { stale: true };
			}
			this.db
				.prepare(
					`UPDATE context_cache SET hit_count = hit_count + 1, last_hit_at = ?,
					 tier = ?, expires_at = ? WHERE cache_key = ?`,
				)
				.run(
					now,
					tierForHits(row.hit_count + 1),
					now + ttlSecondsForTier(tierForHits(row.hit_count + 1), this.baseTtl),
					cacheKey,
				);
			return { bundle: JSON.parse(row.bundle_json), hit_count: row.hit_count + 1 };
		} catch {
			return null;
		}
	}

	put({ cache_key, project_id, bundle, repo_commit, dependency_fp, admission }) {
		if (!this.db || !cache_key || !bundle) return false;
		if (admission === "REJECT") return false;
		const now = nowSec();
		const exp = now + ttlSecondsForTier("candidate", this.baseTtl);
		try {
			this.db
				.prepare(
					`INSERT INTO context_cache(cache_key, project_id, bundle_json, repo_commit, dependency_fp,
					 hit_count, created_at, last_hit_at, expires_at, tier)
					 VALUES(?,?,?,?,?,0,?,?,?,'candidate')
					 ON CONFLICT(cache_key) DO UPDATE SET
					   bundle_json=excluded.bundle_json,
					   dependency_fp=excluded.dependency_fp,
					   last_hit_at=excluded.last_hit_at,
					   expires_at=excluded.expires_at`,
				)
				.run(cache_key, project_id, JSON.stringify(bundle), repo_commit ?? "", dependency_fp, now, now, exp);
			return true;
		} catch {
			return false;
		}
	}
}
