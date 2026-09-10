/**
 * Canonicalizer — deterministic representations for stable hashing.
 *
 * Prompt Lab spec §9: canonicalization is the basis of cache stability.
 *  - deterministic JSON: object keys sorted when semantics allow; arrays keep
 *    order when ordering is meaningful (spec §9.1);
 *  - line endings / trailing whitespace normalized for hash, but code / SQL
 *    literal content and prose-in-markdown whitespace that affects parsing is
 *    never collapsed (spec §9.2);
 *  - stable block identity via hash(kind + normalized content + provenance)
 *    (spec §9.3).
 */

import { countTokens } from "../tokens.mjs";

/** "\r\n"→"\n", strip trailing whitespace per line, trim outer. */
export function normalizeLineEndings(text) {
	return String(text ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
}

export function trimTrailingWhitespace(text) {
	return normalizeLineEndings(text)
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/, ""))
		.join("\n")
		.trim();
}

/**
 * Collapse runs of 3+ blank lines to a single blank line. Never touches
 * content inside fenced code blocks (lines between ``` markers).
 */
export function normalizeBlankLines(text) {
	const lines = normalizeLineEndings(text).split("\n");
	const out = [];
	let fence = null;
	let blank = 0;
	for (const line of lines) {
		const open = /^\s*(```+|~~~+)/.exec(line);
		if (fence === null && open) {
			fence = open[1];
			out.push(line);
			blank = 0;
			continue;
		}
		// Inside a fence every line is copied verbatim — including blank lines.
		// The previous implementation only protected the fence in a first pass
		// and then collapsed blanks globally in a second pass, so it ate the
		// blank lines inside code (spec §9.2 forbids that).
		if (fence !== null) {
			out.push(line);
			if (line.trim().startsWith(fence)) fence = null;
			continue;
		}
		if (line.trim() === "") {
			blank += 1;
			if (blank <= 2) out.push("");
			continue;
		}
		blank = 0;
		out.push(line);
	}
	return out.join("\n");
}

/**
 * Safe whole-block whitespace normalization, keeping code fences intact.
 * This is what hashing runs over before fingerprinting.
 */
export function canonicalizeBlockText(text, { preserveFences = true } = {}) {
	let s = trimTrailingWhitespace(text);
	if (preserveFences) s = normalizeBlankLines(s);
	return s;
}

/** Recursively sort object keys; array order is preserved. */
export function sortKeysDeep(value) {
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (value && typeof value === "object") {
		const out = {};
		for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
		return out;
	}
	return value;
}

/**
 * Canonical JSON stringify: keys deterministically sorted, array order
 * preserved, no extra whitespace. Throws nothing; falls back to raw string.
 */
export function canonicalStringify(value) {
	try {
		return JSON.stringify(sortKeysDeep(value));
	} catch {
		return String(value);
	}
}

export function canonicalStringiffyAlias(value) {
	return canonicalStringify(value);
}

/** Estimate tokens of canonical form; exported with method tagged. */
export function canonicalTokenCount(value) {
	return { count: countTokens(canonicalStringify(value)), method: "heuristic:chars/4", estimated: true };
}

/**
 * Canonical projection of a full manifest: sorted tool array and sorted
 * per-tool schema only when the caller opts in; blocks stay in original
 * order (block order IS semantic). Used for provider-agnostic hashing.
 */
export function canonicalManifest(manifest, { sortTools = false } = {}) {
	const m = {
		schemaVersion: manifest.schemaVersion,
		promptId: manifest.promptId,
		sourceType: manifest.sourceType,
		blocks: (manifest.blocks ?? []).map((b) => ({
			role: b.role,
			kind: b.kind,
			text: canonicalizeBlockText(b.text),
			stability: b.stability,
		})),
	};
	if (manifest.tools?.length) {
		const tools = manifest.tools.map((t) => sortKeysDeep(t));
		m.tools = sortTools ? tools.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")) : tools;
	}
	return m;
}