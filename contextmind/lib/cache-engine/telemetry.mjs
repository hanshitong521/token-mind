import { nowSec } from "./ttl-policy.mjs";

export function recordCacheEvent(db, { project_id, session_id, layer, event, cache_key, saved_tokens = 0, detail = "" }) {
	if (!db) return;
	try {
		db.prepare(
			`INSERT INTO cache_events(ts, project_id, session_id, layer, event, cache_key, saved_tokens, detail)
			 VALUES(?,?,?,?,?,?,?,?)`,
		).run(nowSec(), project_id ?? "", session_id ?? "", layer, event, cache_key ?? "", saved_tokens, detail);
	} catch {
		/* telemetry never load-bearing */
	}
}

export function cacheStats(db) {
	if (!db) return null;
	try {
		const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
		const oldest = (table) =>
			db.prepare(`SELECT MIN(created_at) AS t FROM ${table}`).get()?.t ?? null;
		const hot = db.prepare(`SELECT COUNT(*) AS n FROM prompt_cache WHERE hit_count >= 2`).get()?.n ?? 0;
		return {
			prompt_entries: count("prompt_cache"),
			context_entries: count("context_cache"),
			tool_entries: count("tool_cache"),
			semantic_entries: count("semantic_cache"),
			oldest_prompt_at: oldest("prompt_cache"),
			hot_prompt_entries: hot,
		};
	} catch {
		return null;
	}
}
