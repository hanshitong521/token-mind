import { isRelease } from "./release.mjs";

export function invalidRequest() {
  return isRelease() ? "Invalid request." : "Error: invalid request.";
}

export function missingQuery() {
  return isRelease() ? "Invalid request." : "Error: query is required";
}

export function missingFiles() {
  return isRelease() ? "Invalid request." : "Error: files[] required";
}

export function noSearchResults() {
  return isRelease()
    ? "No results."
    : `No matches. Ingest docs and run semantic_rebuild_index.`;
}

export function ingestOk(written, paths) {
  if (isRelease()) return `Updated ${written} file(s).`;
  return `Ingested ${written} file(s):\n${(paths || []).join("\n")}`;
}

export function rebuildQueued(jobId, status) {
  return isRelease()
    ? "Update queued."
    : `Rebuild enqueued: job_id=${jobId} status=${status}`;
}

export function rebuildDone(jobId, chunks) {
  return isRelease()
    ? "Update complete."
    : `Rebuild done: job_id=${jobId} chunks=${chunks ?? "?"}`;
}

export function unknownTool(name) {
  return isRelease() ? "Unavailable." : `Unknown tool: ${name}`;
}

export function serviceError(message) {
  if (!isRelease()) return `Error: ${message}`;
  const m = String(message || "");
  if (/unauthorized|forbidden|invalid|missing|timeout/i.test(m)) return m;
  return "Service error.";
}

export function missingEvidenceId() {
  return isRelease() ? "Invalid request." : "Error: evidence id required (F-xxxx)";
}

export function evidenceNotFound(id) {
  const tag = String(id || "").trim();
  if (isRelease()) {
    return `Evidence ${tag} not in session. Run semantic_search first or use get_evidence.`;
  }
  return [
    `Evidence ${tag} 不在本会话缓存。`,
    "先 semantic_search 拿到 EVIDENCE ID，或 get_evidence(F-xxxx)；禁止为同条证据重复 embedding。",
  ].join("\n");
}

export function missingTask() {
  return isRelease() ? "Invalid request." : "Error: task is required";
}

export function modelTaskEscalate(reason) {
  if (isRelease()) {
    return "No suitable model available. Handle this task yourself.";
  }
  return `Work-Mind 模型池未接住此任务（${reason || "no_provider_available"}），请自行处理，勿重试本工具。`;
}

export function modelTaskDone(r) {
  const meta = `provider: ${r.provider} | model: ${r.model} | tokens: ${r.usage?.input_tokens || 0} in / ${r.usage?.output_tokens || 0} out | cost: $${r.usage?.estimated_cost_usd ?? 0}`;
  return isRelease() ? r.output : `${r.output}\n\n(${meta})`;
}

export function missingFilePath() {
  return isRelease() ? "Invalid request." : "Error: file_path is required";
}

export function missingEvidenceIdEv() {
  return isRelease() ? "Invalid request." : "Error: evidence_id is required (EV-xxxx)";
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString("en-US");
}

export function logInvestigateDone(r) {
  if (isRelease()) {
    const lines = [
      `Log investigation: ${fmtNum(r.total_lines)} lines, ${r.template_count} templates, ${r.latency_ms}ms.`,
      `Tokens: ${fmtNum(r.tokens?.raw)} raw → ${fmtNum(r.tokens?.delivered)} delivered (${r.tokens?.reduction_pct}% reduction).`,
      `Evidence: ${r.evidence?.report_evidence_id} (context_expand to retrieve raw lines).`,
      "",
      "Suspects:",
      ...(r.suspects || []).slice(0, 5).map(
        (s) => `  [${s.score}] ${s.template} (${s.reasons?.join(", ")}) count=${s.count}`,
      ),
      "Anomalies:",
      ...(r.anomalies || []).slice(0, 8).map(
        (a) => `  ${a.type}${a.ratio ? ` x${a.ratio}` : ""}: ${a.template} count=${a.count}`,
      ),
    ];
    if (!r.suspects?.length && !r.anomalies?.length) lines.push("No anomalies found.");
    return lines.join("\n");
  }
  const lines = [
    `[log-investigation] ${r.source}`,
    `lines: ${fmtNum(r.total_lines)} | bytes: ${fmtNum(r.bytes)} | templates: ${r.template_count} | latency: ${r.latency_ms}ms`,
    `timespan: ${r.timespan?.first ?? "?"} → ${r.timespan?.last ?? "?"}`,
    `levels: ${Object.entries(r.level_counts || {}).map(([k, v]) => `${k}=${fmtNum(v)}`).join(" ") || "n/a"}`,
    `tokens: raw ${fmtNum(r.tokens?.raw)} → delivered ${fmtNum(r.tokens?.delivered)}（省 ${r.tokens?.reduction_pct}%）`,
    `evidence: ${r.evidence?.report_evidence_id}（context_expand 可按 template_id/时间/行号 恢复原文）`,
    "",
    "suspects（启发式根因候选，需 context_expand 验证）:",
    ...(r.suspects || []).slice(0, 5).map(
      (s) => `  #${s.template_id} score=${s.score} [${s.reasons?.join(", ")}] count=${fmtNum(s.count)}\n     ${s.template}`,
    ),
    "anomalies:",
    ...(r.anomalies || []).slice(0, 8).map(
      (a) => `  ${a.type}${a.ratio ? ` x${a.ratio}` : ""} tpl#${a.template_id} count=${fmtNum(a.count)}: ${a.template}`,
    ),
    "timeline:",
    ...(r.timeline || []).slice(0, 12).map((t) => `  line ${fmtNum(t.line)} ${t.at ?? ""} ${t.event}: ${t.detail}`),
    "exceptions:",
    ...(r.exceptions || []).slice(0, 8).map(
      (e) => `  ${e.type}${e.top_frame ? ` @ ${e.top_frame}` : ""} count=${fmtNum(e.count)}`,
    ),
  ];
  if (!r.suspects?.length && !r.anomalies?.length) lines.push("（未发现异常模式）");
  return lines.join("\n");
}

export function contextExpandDone(r) {
  const head = isRelease()
    ? `Evidence ${r.evidence_id} (${r.mode}): matched ${fmtNum(r.matched)} of ${fmtNum(r.lines_scanned)} lines${r.truncated ? " [truncated: narrow filters]" : ""}.`
    : `evidence ${r.evidence_id} mode=${r.mode} matched=${fmtNum(r.matched)}/${fmtNum(r.lines_scanned)} 行${r.truncated ? "（已达 max_tokens，收窄过滤条件）" : ""}`;
  return `${head}\n${(r.lines || []).join("\n")}`;
}

export function tokenWasteReport(r) {
  const rows = Object.entries(r.attribution || {}).map(
    ([source, v]) => `  ${source.padEnd(14)} saved ${fmtNum(v.saved_tokens)}（${fmtNum(v.calls)} 次调用，raw ${fmtNum(v.raw_tokens)} → delivered ${fmtNum(v.delivered_tokens)}）`,
  );
  if (isRelease()) {
    return [
      `Today's token savings: ${fmtNum(r.total_saved_tokens)}.`,
      ...Object.entries(r.attribution || {}).map(
        ([source, v]) => `  ${source}: ${fmtNum(v.saved_tokens)} saved over ${v.calls} call(s)`,
      ),
    ].join("\n");
  }
  return [
    `Today's Savings（${r.date}）: ${fmtNum(r.total_saved_tokens)} tokens`,
    "attribution:",
    ...(rows.length ? rows : ["  （今天还没有节省记录）"]),
    `search: gate_saved ${fmtNum(r.search?.saved_tokens)} + vs_full_read ${fmtNum(r.search?.avoided_read_tokens)} / raw ${fmtNum(r.search?.raw_tokens)}（${fmtNum(r.search?.searches)} 次，cache_hits=${fmtNum(r.search?.cache_hits)}）`,
    `口径: ${r.note}`,
  ].join("\n");
}
