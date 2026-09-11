/**
 * Orient dedup key — FQCN / path / short name / ServiceImpl variants → one symbol.
 * com.foo.BarServiceImpl ≡ BarService ≡ Bar → "bar"
 */
export function normalizeOrientQuery(q) {
	let s = String(q ?? "")
		.trim()
		.toLowerCase()
		.replace(/\\/g, "/")
		.replace(/\.java$/, "");
	if (!s) return "";
	if (s.includes("/")) s = s.split("/").filter(Boolean).pop() || s;
	if (s.includes(".")) {
		const parts = s.split(".").filter(Boolean);
		if (parts.length >= 2) s = parts[parts.length - 1];
	}
	// Long-tail: BarServiceImpl / BarService / BarImpl → bar
	s = s.replace(/(service)?impl$/, "").replace(/service$/, "");
	return s.slice(0, 200);
}

export function orientSeenKey(q) {
	const n = normalizeOrientQuery(q);
	return n ? `orient:${n}` : "";
}

/** Single-symbol orient (no globs / multi-token) → fast codegraph node+callers+callees. */
export function isSimpleOrientSymbol(q) {
	const s = String(q ?? "").trim();
	if (!s || s.length > 160) return false;
	if (/\s/.test(s)) return false;
	if (/[*?[\]{}]/.test(s)) return false;
	return true;
}

/** CLI symbol argument: FQCN / path / short name → CodeGraph symbol token. */
export function codegraphSymbolArg(q) {
	let s = String(q ?? "").trim().replace(/\\/g, "/");
	if (!s) return "";
	if (s.endsWith(".java")) {
		const base = s.split("/").pop() || s;
		return base.replace(/\.java$/i, "");
	}
	if (s.includes("/")) return "";
	if (s.includes(".")) {
		const parts = s.split(".").filter(Boolean);
		return parts[parts.length - 1] ?? s;
	}
	return s;
}
