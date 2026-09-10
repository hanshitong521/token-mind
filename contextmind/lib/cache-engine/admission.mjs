/** Cache admission — reject unsafe or unverified payloads (spec §14). */

export const Admission = {
	REJECT: "REJECT",
	EXACT_ONLY: "EXACT_ONLY",
	ALLOW: "ALLOW",
};

const SENSITIVE = /api[_-]?key|secret|password|bearer\s+|private[_-]?key/i;

export function evaluateAdmission(meta = {}) {
	if (meta.has_error) return Admission.REJECT;
	const sample = meta.text_sample ?? meta.sample ?? "";
	if (sample && SENSITIVE.test(String(sample))) return Admission.REJECT;
	if (meta.verified === false) return Admission.REJECT;
	if (meta.kind === "exact_answer" && meta.stable && meta.reusable) return Admission.EXACT_ONLY;
	if (meta.kind === "context_bundle" && meta.stable && meta.reusable && meta.verified !== false) {
		return Admission.ALLOW;
	}
	if (meta.kind === "tool_result" && meta.stable) return Admission.ALLOW;
	if (meta.kind === "semantic" && meta.stable && meta.verified !== false) return Admission.ALLOW;
	if (meta.stable === false) return Admission.REJECT;
	return Admission.ALLOW;
}
