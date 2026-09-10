import { createHash } from "node:crypto";
import { canonicalizePrompt } from "./canonicalizer.mjs";
import { isCacheablePrompt } from "../cache-context.mjs";
import { nowSec, ttlSecondsForTier } from "./ttl-policy.mjs";

function tokenSet(text) {
	return new Set(
		canonicalizePrompt(text)
			.toLowerCase()
			.split(/\s+/)
			.filter(Boolean),
	);
}

export function similarity(a, b) {
	const A = tokenSet(a);
	const B = tokenSet(b);
	if (!A.size || !B.size) return 0;
	let inter = 0;
	for (const t of A) if (B.has(t)) inter++;
	const union = A.size + B.size - inter;
	return union ? inter / union : 0;
}

export class SemanticCache {
	constructor(db, opts = {}) {
		this.db = db;
		this.baseTtl = opts.ttl_sec ?? 600;
		this.threshold = 0.82;
	}

	lookup({ project_id, context_hash, prompt }) {
		if (!isCacheablePrompt(prompt)) return { hit: false, reason: "prompt_not_cacheable" };
		if (!this.db) return { hit: false };
		try {
			const rows = this.db
				.prepare(
					`SELECT cache_key, context_hash, prompt_sample, output_ref FROM semantic_cache
					 WHERE project_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
				)
				.all(project_id ?? "", nowSec());
			let best = null;
			for (const row of rows) {
				if (context_hash && row.context_hash && row.context_hash !== context_hash) continue;
				const sim = similarity(prompt, row.prompt_sample ?? "");
				if (sim >= this.threshold && (!best || sim > best.sim)) best = { ...row, sim };
			}
			if (!best) return { hit: false };
			return { hit: true, cache_key: best.cache_key, output_ref: best.output_ref, similarity: best.sim };
		} catch {
			return { hit: false };
		}
	}

	async put({ project_id, context_hash, prompt, output_ref, admission }) {
		if (!this.db || !output_ref || admission === "REJECT") return false;
		if (!isCacheablePrompt(prompt)) return false;
		const cache_key = createHash("sha256")
			.update([project_id, context_hash ?? "", canonicalizePrompt(prompt)].join("\u0001"), "utf8")
			.digest("hex");
		const now = nowSec();
		const exp = now + ttlSecondsForTier("temporary", this.baseTtl);
		try {
			this.db
				.prepare(
					`INSERT INTO semantic_cache(cache_key, project_id, context_hash, prompt_sample, output_ref,
					 hit_count, created_at, expires_at)
					 VALUES(?,?,?,?,?,0,?,?)
					 ON CONFLICT(cache_key) DO UPDATE SET
					   output_ref=excluded.output_ref,
					   prompt_sample=excluded.prompt_sample,
					   expires_at=excluded.expires_at`,
				)
				.run(
					cache_key,
					project_id ?? "",
					context_hash ?? "",
					canonicalizePrompt(prompt).slice(0, 500),
					output_ref,
					now,
					exp,
				);
			return true;
		} catch {
			return false;
		}
	}
}
