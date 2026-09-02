/**
 * Token counting.
 *
 * spec 11.1 demands a real tokenizer for final benchmarks. Every Token-Mind
 * bench to date (bench/report.md, bench/shejiu_live_report.md,
 * bench/shell_owner_retest.md) measures with chars/4, so switching estimators
 * here would silently invalidate the baseline we compare against. The seam is
 * explicit instead: the id travels with every telemetry row and every report,
 * so a reader can tell which numbers are heuristic.
 *
 * Swapping in a real tokenizer means changing countTokens and TOKENIZER_ID
 * together, then re-running the baseline — not mixing the two in one report.
 */

export const TOKENIZER_ID = "heuristic:chars/4";

/** Tokens for a string. Uses UTF-8 bytes so CJK does not count as one char. */
export function countTokens(text) {
	if (typeof text !== "string") return 0;
	return Math.max(text.length === 0 ? 0 : 1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

/** Tokens for a value that may be a string, JSON, or already-structured. */
export function countTokensOf(value) {
	if (value === null || value === undefined) return 0;
	return countTokens(typeof value === "string" ? value : JSON.stringify(value) ?? "");
}

/**
 * Clamp text to a token budget without cutting mid-line where avoidable.
 *
 * Head-only truncation is what spec 11.4 forbids as a *sole* strategy; this is
 * the last-resort tail of the pipeline, used only after classification and the
 * first-layer compressor, and callers must attach a handle to the raw text.
 */
export function truncateToTokens(text, budgetTokens) {
	const maxBytes = budgetTokens * 4;
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const buf = Buffer.from(text, "utf8");
	let end = buf.subarray(0, maxBytes).toString("utf8");
	// Drop the partial trailing line rather than emit half a line of code.
	const lastNl = end.lastIndexOf("\n");
	if (lastNl > 0) end = end.slice(0, lastNl);
	return `${end}\n... [truncated: budget ${budgetTokens} tokens]`;
}
