/** Reuse openRuntime(projectRoot) inside the daemon process (avoid per-hook SQLite cold open). */
const MAX = 8;
const cache = new Map();

export function cachedOpenRuntime(projectRoot, openRuntime) {
	const key = String(projectRoot ?? "");
	let entry = cache.get(key);
	if (entry) {
		entry.last = Date.now();
		return entry.rt;
	}
	if (cache.size >= MAX) {
		let oldest = null;
		for (const [k, v] of cache) {
			if (!oldest || v.last < oldest.last) oldest = { k, ...v };
		}
		if (oldest) {
			try {
				oldest.rt?.close?.();
			} catch {
				/* ok */
			}
			cache.delete(oldest.k);
		}
	}
	const rt = openRuntime(projectRoot);
	cache.set(key, { rt, last: Date.now() });
	return rt;
}
