import { nowSec, tierForHits, ttlSecondsForTier } from "./ttl-policy.mjs";

export class ExactCache {
	constructor(db, opts = {}) {
		this.db = db;
		this.baseTtl = opts.ttl_sec ?? 600;
	}

	get(cacheKey) {
		if (!this.db || !cacheKey) return null;
		const now = nowSec();
		try {
			const row = this.db
				.prepare(
					`SELECT output_ref, hit_count, expires_at, tier FROM prompt_cache
					 WHERE cache_key = ? AND (expires_at IS NULL OR expires_at > ?)`,
				)
				.get(cacheKey, now);
			if (!row) return null;
			this.db
				.prepare(
					`UPDATE prompt_cache SET hit_count = hit_count + 1, last_hit_at = ?,
					 tier = ?, expires_at = ?
					 WHERE cache_key = ?`,
				)
				.run(
					now,
					tierForHits(row.hit_count + 1),
					now + ttlSecondsForTier(tierForHits(row.hit_count + 1), this.baseTtl),
					cacheKey,
				);
			return { output_ref: row.output_ref, hit_count: row.hit_count + 1 };
		} catch {
			return null;
		}
	}

	put({ cache_key, project_id, prompt_hash, context_hash, model_family, output_ref, admission }) {
		if (!this.db || !cache_key || !output_ref) return false;
		if (admission === "REJECT") return false;
		const now = nowSec();
		const exp = now + ttlSecondsForTier("temporary", this.baseTtl);
		try {
			this.db
				.prepare(
					`INSERT INTO prompt_cache(cache_key, project_id, prompt_hash, context_hash, model_family,
					 output_ref, hit_count, created_at, last_hit_at, expires_at, tier)
					 VALUES(?,?,?,?,?,?,0,?,?,?,'temporary')
					 ON CONFLICT(cache_key) DO UPDATE SET
					   output_ref=excluded.output_ref,
					   last_hit_at=excluded.last_hit_at,
					   expires_at=excluded.expires_at`,
				)
				.run(cache_key, project_id, prompt_hash, context_hash ?? "", model_family ?? "", output_ref, now, now, exp);
			return true;
		} catch {
			return false;
		}
	}
}
