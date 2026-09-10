/** Aggregate cache_events + prompt_pipeline_events for dashboards. */

export function summarizeCacheLedger(db) {
	if (!db) return null;
	try {
		const hits = db
			.prepare(`SELECT layer, COUNT(*) AS n FROM cache_events WHERE event = 'hit' GROUP BY layer`)
			.all();
		const hits_by_layer = {};
		for (const r of hits) hits_by_layer[r.layer] = r.n;
		const pipeline = db
			.prepare(
				`SELECT
				   SUM(CASE WHEN stage = 'exact_hit' THEN 1 ELSE 0 END) AS hits,
				   COUNT(*) AS total
				 FROM prompt_pipeline_events`,
			)
			.get();
		const total = pipeline?.total ?? 0;
		const hitN = pipeline?.hits ?? 0;
		return {
			hits_by_layer,
			pipeline: {
				events: total,
				hits: hitN,
				hit_rate_pct: total ? Math.round((hitN / total) * 1000) / 10 : null,
			},
		};
	} catch {
		return null;
	}
}
