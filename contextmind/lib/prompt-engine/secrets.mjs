/**
 * Secret Guard — scan a manifest / plain text for credential-like material
 * before persisting to history or sending anywhere (spec §38).
 *
 * Default policy (spec §38, tightened by the round-1 baseline decision):
 *  - public result, telemetry, report, UI payload, fixture snapshot and debug
 *    output are ALL redacted by default;
 *  - showing the live input is an explicit opt-out (`redactSecrets: false`),
 *    never the default;
 *  - Eval never forwards secrets to an external judge.
 *
 * Two output shapes, deliberately separated:
 *  - `detectSecrets()`  → internal, carries the raw `match` (never serialize);
 *  - `scanSecrets()`    → safe summary (names + counts only), safe to persist.
 *
 * The detector is conservative (regex first, entropy only for JWT-ish shapes);
 * a false positive costs a redaction marker, a false negative leaks a
 * credential, so the bias is intentional.
 */

const SECRET_PATTERNS = Object.freeze([
	// Block-shaped keys first: longest/most specific wins on overlap.
	{ name: "private_key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]{0,4000}?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g },
	{ name: "private_key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g },
	{ name: "jwt", re: /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_=-]{8,}\b/g },
	{ name: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g },
	// Optional scheme word, so "Authorization: Basic <b64>" is caught and not
	// just the header name.
	{ name: "authorization", re: /\bauthorization\s*[:=]\s*["']?(?:basic|bearer|token|digest)?\s*[A-Za-z0-9._~+/=-]{12,}/gi },
	{ name: "api_key", re: /\b(?:sk|pk|rk)[-_](?:proj|live|test|ant|svc)?[-_]?[A-Za-z0-9._-]{16,}\b/g },
	{ name: "api_key", re: /\b(?:sk|pk|rk|gh[ps]_|github_pat_|AIza|AKIA|xox[baprs]-)[A-Za-z0-9._-]{16,}\b/g },
	{ name: "api_key", re: /\bapi[_-]?key\b\s*["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/gi },
	{ name: "access_token", re: /\b(?:access|refresh|id)[_-]?token\b\s*["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/gi },
	{ name: "client_secret", re: /\bclient[_-]?secret\b\s*["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/gi },
	{ name: "password", re: /\b(?:password|passwd|pwd)\b\s*["']?\s*[:=]\s*["']?[^\s"',;]{6,}/gi },
	// `session_id`/`request_id` are deliberately NOT here: they are volatile
	// identifiers (a cache killer, see volatility.mjs) rather than credentials.
	// Treating them as secrets produced false CRITICALs and maxed the risk score.
	{ name: "cookie", re: /\b(?:cookie|set-cookie|sessionid|jsessionid)\b\s*[:=]\s*["']?[A-Za-z0-9._%+-]{12,}/gi },
	{ name: "database_url", re: /\b(?:mongodb|postgres(?:ql)?|mysql|mssql|redis|amqp)(?:\+[a-z]+)?:\/\/[^\s"'<>]{8,}/gi },
	{ name: "ssh_key", re: /\bssh-(?:rsa|ed25519|dss)\s+AAAA[0-9A-Za-z+/]{16,}/g },
	{ name: "aws_access", re: /\bAKIA[A-Z0-9]{16}\b/g },
]);

/**
 * Internal detector. Returns overlapping-free spans:
 *   { name, index, length, match }
 * `match` is the RAW credential — never put this in a report, a finding, or
 * a log line. Use `scanSecrets()` for anything that leaves the process.
 */
export function detectSecrets(text) {
	const source = String(text ?? "");
	if (!source) return [];
	const raw = [];
	for (const { name, re } of SECRET_PATTERNS) {
		re.lastIndex = 0;
		for (const m of source.matchAll(re)) {
			raw.push({ name, index: m.index, length: m[0].length, match: m[0] });
		}
	}
	// Greedy de-overlap: earliest start wins, longest span breaks ties, so an
	// "authorization: Bearer x" does not emit two overlapping edits.
	raw.sort((a, b) => (a.index - b.index) || (b.length - a.length));
	const out = [];
	let cursor = -1;
	for (const hit of raw) {
		if (hit.index < cursor) continue;
		out.push(hit);
		cursor = hit.index + hit.length;
	}
	return out;
}

/** Safe summary: names + counts, no credential material. Safe to persist. */
export function scanSecrets(text) {
	const hits = detectSecrets(text);
	const byName = {};
	for (const h of hits) byName[h.name] = (byName[h.name] ?? 0) + 1;
	return { count: hits.length, byName };
}

/** Redact every secret span in a string. Returns { text, hits } (hits are raw). */
export function redactText(text) {
	const source = String(text ?? "");
	const hits = detectSecrets(source);
	if (hits.length === 0) return { text: source, hits: [] };
	let out = source;
	for (let i = hits.length - 1; i >= 0; i -= 1) {
		const h = hits[i];
		out = out.slice(0, h.index) + `[REDACTED:${h.name}]` + out.slice(h.index + h.length);
	}
	return { text: out, hits };
}

/**
 * Full manifest redaction: rebuild the manifest with every block's secret
 * spans turned into markers. Block `id` is preserved so findings computed on
 * the pre-redaction manifest still resolve; `text` and `hash` change.
 * Returns a new manifest (original untouched).
 */
export function redactManifestBlocks(manifest) {
	let hitCount = 0;
	const byName = {};
	const blocks = (manifest?.blocks ?? []).map((b) => {
		const { text, hits } = redactText(b.text);
		hitCount += hits.length;
		for (const h of hits) byName[h.name] = (byName[h.name] ?? 0) + 1;
		return { ...b, text, hash: crashFreeHash(text) };
	});
	return { manifest: { ...manifest, blocks }, hitCount, byName };
}

/**
 * Redact every string reachable from an arbitrary structure (findings,
 * evidence, reports). Prevents a secret from escaping through an evidence
 * snippet even when the block text itself was redacted.
 */
export function redactDeep(value) {
	const walk = (v) => {
		if (typeof v === "string") return redactText(v).text;
		if (Array.isArray(v)) return v.map(walk);
		if (v && typeof v === "object") {
			const out = {};
			for (const [k, val] of Object.entries(v)) out[k] = walk(val);
			return out;
		}
		return v;
	};
	return walk(value);
}

/** sha256 helper without importing crypto at top-level (module is sync). */
import { createHash } from "node:crypto";
function crashFreeHash(s) {
	try {
		return createHash("sha256").update(s).digest("hex");
	} catch {
		return "redacted:" + s.length;
	}
}

/**
 * Guard for outbound payloads (Eval / judge / telemetry).
 * strict=true refuses to forward; strict=false reports that redaction is due.
 * Never returns the credential itself.
 */
export function assertNoSecrets(text, { strict = false } = {}) {
	const summary = scanSecrets(text);
	if (summary.count === 0) return { ok: true };
	if (strict) {
		return {
			ok: false,
			error:
				`Secret guard: ${summary.count} secret(s) detected (${Object.keys(summary.byName).join(",")}). ` +
				`Refusing to forward. Redact before sending to an external judge (spec §38).`,
			hits: summary,
		};
	}
	return { ok: true, redactedHits: summary.count, needsRedaction: true, byName: summary.byName };
}
