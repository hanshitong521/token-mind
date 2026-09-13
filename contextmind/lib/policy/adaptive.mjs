/**
 * Adaptive Hook: must-govern vs optional + dynamic value score.
 * Fifth Read is an example, not a hardcoded rule.
 *
 * value = risk * contextImpact * repeatCount
 */

const MUST = [
	"shell",
	"bash",
	"git",
	"build",
	"test",
	"log",
	"mysql",
	"db",
	"ads-mysql",
];

export function mustGovern(toolName, { command, server } = {}) {
	const n = String(toolName ?? "").toLowerCase();
	const blob = `${n} ${command ?? ""} ${server ?? ""}`.toLowerCase();
	if (MUST.some((k) => blob.includes(k))) return true;
	if (/\b(mvn|gradle|pytest|jest|npm test|cargo test)\b/.test(blob)) return true;
	if (/\.(log|out)$/i.test(blob)) return true;
	if (n.includes("codegraph") && !n.includes("context_")) return true;
	return false;
}

export function toolValueScore({ risk = 1, contextImpact = 1, repeats = 1 } = {}) {
	const r = Math.max(1, Number(risk) || 1);
	const c = Math.max(1, Number(contextImpact) || 1);
	const n = Math.max(1, Number(repeats) || 1);
	return r * c * n;
}

export function estimateRisk({ toolName, command, unbounded, failure } = {}) {
	if (failure) return 5;
	if (mustGovern(toolName, { command })) return 4;
	if (unbounded) return 3;
	const n = String(toolName ?? "").toLowerCase();
	if (n.includes("read") || n.includes("grep") || n.includes("glob")) return 2;
	return 1;
}

export function estimateImpact({ unbounded, fileTokens = 0 } = {}) {
	if (unbounded && fileTokens > 2_000) return 4;
	if (unbounded) return 3;
	if (fileTokens > 800) return 2;
	return 1;
}

/** Optional Read/Grep/Glob: govern when score is high or safety requires it. */
export function shouldGovernOptional(score, { safety = false, threshold = 4 } = {}) {
	if (safety) return true;
	return score >= threshold;
}
