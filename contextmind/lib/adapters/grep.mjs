import { forbiddenAgentScanPath } from "../path-guards.mjs";

export const GREP_DEFAULT_HEAD = 30;
export const GREP_MAX_HEAD = 80;

export function clampGrepHead(limit) {
	const n = Number(limit);
	if (!Number.isFinite(n) || n <= 0) return GREP_DEFAULT_HEAD;
	if (n > GREP_MAX_HEAD) return GREP_MAX_HEAD;
	return n;
}

export function grepKey(pattern, path, head) {
	return `${String(pattern ?? "").slice(0, 200)}|${String(path ?? "").replace(/\\/g, "/")}|${head}`;
}

export function forbiddenGrep(path) {
	return forbiddenAgentScanPath(path);
}
