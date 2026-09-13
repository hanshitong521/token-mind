/**
 * Evidence P0–P3. Maps classify() output; does not invent a second compressor.
 *
 * P0 错误/安全/测试失败 → 永不压
 * P1 接口/核心代码 → 谨慎
 * P2 普通实现 → 可压
 * P3 历史信息 → 先压
 */

const SECURITY_RE =
	/\b(password|secret|api[_-]?key|authorization|private[_-]?key|sql injection|path traversal|rce|privilege)\b/i;

export function evidenceLevel(cls, { cmd, toolName, raw } = {}) {
	const type = cls?.type ?? "generic";
	const failure = Boolean(cls?.failure);
	const blob = `${cmd ?? ""} ${toolName ?? ""} ${String(raw ?? "").slice(0, 4000)}`;

	if (type === "stacktrace") return "P0";
	if (failure && (type === "test_log" || type === "build_log")) return "P0";
	if (SECURITY_RE.test(blob) && failure) return "P0";
	if (/\b(EACCES|EPERM|401|403|AccessDenied|permission denied)\b/i.test(blob) && failure) return "P0";

	if (type === "source" || type === "json") return "P1";
	if (/\b(sql|mysql_query|SELECT |INSERT |UPDATE |DELETE )\b/i.test(blob) && type !== "generic") return "P1";

	if (type === "git_log" || type === "git_diff") return "P3";
	if (type === "generic" && !failure) return "P3";

	return "P2";
}

export function compressionOrder() {
	return ["P3", "P2", "P1", "P0"];
}

export const BUDGET_INSUFFICIENT_MESSAGE =
	"当前预算不足；已保留关键证据；建议继续或增加预算。";
