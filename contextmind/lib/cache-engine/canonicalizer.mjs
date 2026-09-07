/**
 * Prompt / text canonicalization for stable cache keys (spec §6 L0).
 */

export function canonicalizePrompt(text) {
	if (text == null) return "";
	let s = String(text);
	s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
	s = s.split("\n").map((line) => line.trimEnd()).join("\n");
	s = s.trim();
	s = s.replace(/\s+/g, " ");
	return s;
}

export function normalizeToolArgs(args) {
	if (args == null) return "";
	if (typeof args === "string") return canonicalizePrompt(args);
	try {
		return JSON.stringify(sortKeys(args));
	} catch {
		return canonicalizePrompt(String(args));
	}
}

function sortKeys(v) {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v && typeof v === "object") {
		const out = {};
		for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
		return out;
	}
	return v;
}
