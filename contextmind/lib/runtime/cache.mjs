/** In-process Runtime cache (git summaries, request memo). Not a Tool Gateway. */

export function createRuntimeCache({ maxEntries = 512 } = {}) {
	const map = new Map();
	return {
		get(key) {
			const hit = map.get(key);
			if (!hit) return null;
			if (hit.expiresAt && hit.expiresAt < Date.now()) {
				map.delete(key);
				return null;
			}
			hit.hits += 1;
			return hit.value;
		},
		set(key, value, ttlMs = 300_000) {
			if (map.size >= maxEntries) {
				const first = map.keys().next().value;
				if (first !== undefined) map.delete(first);
			}
			map.set(key, { value, hits: 0, expiresAt: ttlMs ? Date.now() + ttlMs : 0 });
		},
		stats() {
			return { size: map.size, maxEntries };
		},
	};
}
