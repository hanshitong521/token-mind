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
