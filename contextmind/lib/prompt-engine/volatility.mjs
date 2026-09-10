/**
 * Early Volatility Detector — port of the Headroom "dynamic content detector"
 * idea (universal + structural + entropy, no hardcoded locale names) into
 * zero-dependency Node. Scans text for volatile tokens (timestamps, UUIDs,
 * session ids, hashes, nonces) that would break a provider prefix cache.
 *
 * Prompt Lab spec §11.1: if volatile spans appear in the stable region of a
 * prompt, report CACHE_PREFIX_BREAKER.
 */

import { sha256 } from "./manifest.mjs";

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_DATETIME_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM))?\b/gi;
const UNIPX_RE = /\b\d{10,13}\b/g;
const HASH_HEX_RE = /\b[a-f0-9]{32,64}\b/gi;
const SESSION_RE = /\b(?:session|request|trace|span|txn|correlation|nonce|_id)[-_:\s]*(?:id|Id|ID)?\s*[:=]\s*[0-9a-zA-Z-]{8,}\b/gi;
const JWT_RE = /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g;
// Contextual git state. A bare 7-hex token is NOT sufficient evidence — too
// many ordinary words are hex-legal ("facade", "decade") — so the commit/sha
// keyword must sit next to it.
const GIT_REF_RE = /\b(?:commit|sha1?|revision|rev|head)[-_\s]*(?:id|Id|ID)?\s*[:=]?\s*([0-9a-f]{7,40})\b/gi;
const BRANCH_RE = /\b(?:(?:on|current)\s+branch|branch)\s*[:=]\s*([A-Za-z0-9._\-/]{3,60})\b/gi;
// Absolute filesystem paths are machine/user specific and differ per session.
const ABS_PATH_RE = /(?:\b[A-Za-z]:\\[^\s"'<>|*?]{3,}|\/(?:home|Users|usr|var|opt|mnt|data|root)\/[^\s"'<>|*?]{3,})/g;

/**
 * Volatility categories, most-specific first. Span de-dup keeps the earliest
 * match, so ordering here decides which label wins on an overlap (a JWT also
 * looks like a long dynamic-id, and we want "jwt").
 */
export const VOLATILE_CATEGORIES = Object.freeze([
	"jwt",
	"uuid",
	"datetime",
	"timestamp",
	"time",
	"git-ref",
	"branch",
	"session",
	"hash",
	"path",
	"dynamic-id",
]);

/** Shannon entropy normalized to 0..1; high ⇒ random-looking ⇒ volatile. */
export function normalizedEntropy(s) {
	if (!s) return 0;
	const len = s.length;
	const freq = new Map();
	for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
	let entropy = 0;
	for (const n of freq.values()) {
		const p = n / len;
		entropy -= p * Math.log2(p);
	}
	const maxEntropy = Math.log2(len) || 1;
	if (maxEntropy <= 0 || entropy <= 0) return 0;
	return Math.min(1, entropy / maxEntropy);
}

/** Translate the Headroom DynamicCategory into Prompt Lab severity labels. */
export function categoryLabel(category) {
	switch (category) {
		case "timestamp":
		case "datetime":
		case "time":
			return "timestamp-like";
		case "uuid":
			return "uuid";
		case "hash":
			return "hash";
		case "session":
			return "session/request id";
		case "jwt":
			return "jwt";
		case "version":
			return "version";
		case "git-ref":
			return "git commit sha";
		case "branch":
			return "git branch";
		case "path":
			return "absolute path";
		default:
			return "dynamic";
	}
}

/**
 * Return a list of volatile spans: { start, end, text, category, label }.
 * Order is by position in text. Deterministic.
 */
export function detectVolatileSpans(text) {
	const source = String(text ?? "");
	const spans = [];
	const push = (start, end, category) => {
		const snippet = source.slice(start, end);
		if (end - start < 3) return;
		// de-dup overlapping ranges (prefer the earlier/longer match)
		for (const s of spans) {
			if (start < s.end && end > s.start) return;
		}
		spans.push({ start, end, text: snippet, category, label: categoryLabel(category) });
	};

	const matchers = [
		[JWT_RE, "jwt"],
		[UUID_RE, "uuid"],
		[ISO_DATETIME_RE, "datetime"],
		[ISO_DATE_RE, "timestamp"],
		[TIME_RE, "time"],
		[UNIPX_RE, "timestamp"],
		[GIT_REF_RE, "git-ref"],
		[BRANCH_RE, "branch"],
		[HASH_HEX_RE, "hash"],
		[SESSION_RE, "session"],
		[ABS_PATH_RE, "path"],
	];
	for (const [re, category] of matchers) {
		for (const m of source.matchAll(re)) push(m.index, m.index + m[0].length, category);
	}

	// Entropy pass for UNNAMED random-looking identifiers. Deliberately narrow:
	// an over-eager version of this classified "package.json" as a dynamic id
	// and collapsed the stable prefix of an otherwise fully static prompt.
	const wordRe = /\b[a-zA-Z0-9_\-]{16,}\b/g;
	for (const m of source.matchAll(wordRe)) {
		const token = m[0];
		// must mix classes: a pure word or pure number is not a generated id
		if (!/[a-zA-Z]/.test(token) || !/\d/.test(token)) continue;
		if (normalizedEntropy(token) >= 0.62) {
			push(m.index, m.index + token.length, "dynamic-id");
		}
	}

	spans.sort((a, b) => a.start - b.start);
	return dedupeSpans(spans);
}

function dedupeSpans(spans) {
	const out = [];
	for (const s of spans) {
		if (out.length > 0 && s.start < out[out.length - 1].end) continue;
		out.push(s);
	}
	return out;
}

/** Volatile tokens found in a block, annotated with their span positions. */
export function analyzeBlockVolatility(block) {
	const text = String(block?.text ?? "");
	if (!text) return { volatile: false, spans: [], entropy: 0, hash: sha256(text, 8) };
	const spans = detectVolatileSpans(text);
	return {
		volatile: spans.length > 0,
		spans,
		entropy: text.length > 0 ? normalizedEntropy(text.slice(0, 512)) : 0,
		hash: sha256(text, 8),
	};
}

/**
 * Content-derived stability §10. A declared class is a *claim*; the text is
 * the evidence. Volatile content can only ever DEMOTE a block
 * (STATIC → DYNAMIC → EPHEMERAL), never promote it, so a genuinely static
 * block is never wrongly marked reusable-sounding.
 *
 * EPHEMERAL when the block is mostly made of volatile spans (a bare
 * "current time: ..." line); DYNAMIC when it merely carries some.
 *
 * Returns the effective stability; `declared` is returned untouched when no
 * volatile evidence exists.
 */
const STABILITY_RANK = Object.freeze({ STATIC: 0, MOSTLY_STATIC: 1, DYNAMIC: 2, EPHEMERAL: 3 });

export function volatileCoverage(text, spans) {
	const len = Math.max(1, String(text ?? "").length);
	const covered = (spans ?? []).reduce((a, s) => a + (s.end - s.start), 0);
	return covered / len;
}

export function stabilityFromContent(text, declared = "STATIC") {
	const source = String(text ?? "");
	if (!source.trim()) return declared;
	const spans = detectVolatileSpans(source);
	if (spans.length === 0) return declared;

	const coverage = volatileCoverage(source, spans);
	let effective = coverage >= 0.2 ? "EPHEMERAL" : "DYNAMIC";
	if (STABILITY_RANK[effective] < STABILITY_RANK[declared]) effective = declared;
	return effective;
}