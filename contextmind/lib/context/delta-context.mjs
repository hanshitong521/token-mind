/**
 * Session delta — what context was already sent (spec §9 / L3).
 * Builds on SessionSeen; pure helpers for prompt pipeline.
 */

export function deltaFromSeen(seenDigest, resources = []) {
	const sent = new Set();
	if (seenDigest?.lines) {
		for (const line of seenDigest.lines) {
			const m = /^(\w+):(.+)$/.exec(line);
			if (m) sent.add(`${m[1]}:${m[2]}`);
		}
	}
	const fresh = [];
	const skipped = [];
	for (const r of resources) {
		const id = `${r.kind ?? "path"}:${r.key}`;
		if (sent.has(id)) skipped.push(r);
		else fresh.push(r);
	}
	return { fresh, skipped, reuse_rate: resources.length ? skipped.length / resources.length : 0 };
}
