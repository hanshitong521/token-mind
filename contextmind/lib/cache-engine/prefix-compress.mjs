import { countTokens, truncateToTokens } from "../tokens.mjs";

/** Trim stable-prefix block to token budget (optional context-compress hook). */
export function compressStablePrefix(body, _cfg, { maxTokens = 220 } = {}) {
	const text = String(body ?? "");
	const tokens = countTokens(text);
	if (tokens <= maxTokens) return { text, method: "none" };
	return { text: truncateToTokens(text, maxTokens), method: "truncate" };
}
