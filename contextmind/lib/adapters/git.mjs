import { createHash } from "node:crypto";

export function isGitCommand(command) {
	return /^\s*git\b/i.test(String(command ?? ""));
}

export function gitCacheKey(command, output) {
	const h = createHash("sha256").update(String(output ?? "")).digest("hex").slice(0, 16);
	return `git:${String(command ?? "").slice(0, 80)}:${h}`;
}

export function gitSummary(output, { maxLines = 40 } = {}) {
	const lines = String(output ?? "").split("\n");
	const head = lines.slice(0, maxLines).join("\n");
	const omitted = Math.max(0, lines.length - maxLines);
	return omitted > 0 ? `${head}\n... [${omitted} more lines; git adapter cache]` : head;
}

export function cachedGitSummary(cache, command, output) {
	if (!cache) return gitSummary(output);
	const key = gitCacheKey(command, output);
	const hit = cache.get(key);
	if (hit) return { text: hit, cacheHit: true, key };
	const text = gitSummary(output);
	cache.set(key, text);
	return { text, cacheHit: false, key };
}
