import { compressSqlResult, normalizeSqlResult } from "./sql-result-compress.mjs";
import { checkBeforeDeliver, registerDeliveredContent, getStoredBody } from "./context-dedup.mjs";
import { recordFromText } from "./context-ledger.mjs";
import { estimateTokens } from "./token-estimate.mjs";
import { registerRawPayload } from "./evidence-store.mjs";
import {
  readFileSnapshot,
  diffLineRanges,
  formatDeltaHunks,
} from "./incremental-read.mjs";
import { wrapIfSaves, extractEvidenceIds } from "./gate-envelope.mjs";

const DEFAULT_MAX_TOKENS = Number(process.env.TOKEN_SKILL_GATE_MAX_TOKENS || 1200);
const POLICY_VERSION = "tool-gate-1";

/**
 * @typedef {"json" | "sql" | "log" | "code" | "markdown" | "text" | "auto"} ContentKind
 */

/**
 * @param {string} kind
 * @param {string} text
 * @returns {ContentKind}
 */
export function detectContentKind(kind, text) {
  const k = String(kind || "auto").toLowerCase();
  if (k !== "auto" && k !== "") return /** @type {ContentKind} */ (k);
  const t = String(text || "").trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      JSON.parse(t);
      return "json";
    } catch {
      /* fall through */
    }
  }
  if (/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(t) && /"rows"\s*:|columns/i.test(t)) {
    return "sql";
  }
  if (/^\d{4}-\d{2}-\d{2}|ERROR|WARN|Exception|Traceback/i.test(t)) {
    return "log";
  }
  if (/^#{1,6}\s/m.test(t)) return "markdown";
  if (/^(import |export |function |class |def |const |let |var )/m.test(t)) return "code";
  return "text";
}

/**
 * Structured JSON shrink: keep keys, trim long strings and large arrays.
 */
function compressJsonText(text, maxTokens) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, compressed: false };
  }
  const maxChars = maxTokens * 4;
  const visit = (v, depth = 0) => {
    if (depth > 8) return "[max_depth]";
    if (v == null || typeof v !== "object") {
      if (typeof v === "string" && v.length > 400) {
        return v.slice(0, 400) + `…[+${v.length - 400} chars]`;
      }
      return v;
    }
    if (Array.isArray(v)) {
      if (v.length > 12) {
        return [...v.slice(0, 5).map((x) => visit(x, depth + 1)), { __omitted__: v.length - 5 }, ...v.slice(-2).map((x) => visit(x, depth + 1))];
      }
      return v.map((x) => visit(x, depth + 1));
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    const keys = Object.keys(v);
    for (const key of keys.slice(0, 40)) {
      out[key] = visit(v[key], depth + 1);
    }
    if (keys.length > 40) out.__omitted_keys__ = keys.length - 40;
    return out;
  };
  const shrunk = visit(parsed);
  const out = JSON.stringify(shrunk, null, 2);
  if (out.length <= maxChars) return { text: out, compressed: out.length < text.length };
  const hard = out.slice(0, maxChars) + "\n…[budget_truncated]";
  return { text: hard, compressed: true };
}

function compressLogText(text, maxTokens) {
  const lines = String(text).split(/\r?\n/);
  const errIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (/error|exception|fail|fatal|traceback/i.test(lines[i])) errIdx.push(i);
  }
  const keep = new Set();
  for (const i of errIdx) {
    for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j);
  }
  if (!keep.size) {
    for (let i = Math.max(0, lines.length - 30); i < lines.length; i++) keep.add(i);
  }
  const picked = [...keep].sort((a, b) => a - b).map((i) => lines[i]);
  let body = picked.join("\n");
  const maxChars = maxTokens * 4;
  if (body.length > maxChars) body = body.slice(0, maxChars) + "\n…[log_truncated]";
  return { text: body, compressed: body.length < text.length };
}

function budgetTruncate(text, maxTokens) {
  const maxChars = Math.max(64, maxTokens * 4);
  const s = String(text);
  if (s.length <= maxChars) return { text: s, truncated: false };
  const id = registerRawPayload("gate_truncated", s);
  return {
    text:
      s.slice(0, maxChars) +
      `\n\n[budget_gate: truncated; full payload get_evidence(${id})]`,
    truncated: true,
  };
}

/**
 * Unified tool-result pipeline (Phase A).
 *
 * @param {{
 *   payload: string,
 *   source_type?: string,
 *   resource_id?: string,
 *   query?: string,
 *   kind?: string,
 *   max_tokens?: number,
 *   dedup?: boolean,
 *   session_id?: string,
 *   file_path?: string,
 *   delta_read?: boolean,
 * }} input
 */
export function gateToolResult(input) {
  const t0 = Date.now();
  let originalText = String(input.payload ?? "");
  const source_type = String(input.source_type || "mcp_tool");
  let resource_id =
    input.resource_id ||
    `${source_type}:${input.query ? input.query.slice(0, 80) : "body"}`;
  const max_tokens = Number.isFinite(Number(input.max_tokens))
    ? Math.min(8000, Math.max(64, Number(input.max_tokens)))
    : DEFAULT_MAX_TOKENS;
  const dedup = input.dedup !== false;
  const session_id = input.session_id || "default";
  const delta_read = input.delta_read !== false;

  if (input.file_path && typeof input.file_path === "string") {
    let snap;
    try {
      snap = readFileSnapshot(input.file_path);
    } catch (e) {
      const err = `status: ERROR | path_escape | ${e?.message || "denied"}`;
      return {
        text: err,
        status: "NEW_CONTENT",
        metrics: {
          original_tokens: 0,
          delivered_tokens: estimateTokens(err),
          saved_tokens: 0,
          saved_ratio: 0,
        },
      };
    }
    if (!snap) {
      const err = `status: ERROR | file not found or path_escape: ${input.file_path}`;
      return {
        text: err,
        status: "NEW_CONTENT",
        metrics: {
          original_tokens: 0,
          delivered_tokens: estimateTokens(err),
          saved_tokens: 0,
          saved_ratio: 0,
        },
      };
    }
    resource_id = input.resource_id || input.file_path;
    originalText = snap.body;
    if (dedup) {
      const dup = checkBeforeDeliver(resource_id, originalText);
      if (dup) {
        const status = dup.status === "REUSED" ? "UNCHANGED" : dup.status;
        const message =
          status === "UNCHANGED"
            ? dup.message.replace("REUSED", "UNCHANGED")
            : dup.message;
        recordFromText({
          source_type: source_type || "file",
          source_id: resource_id,
          originalText,
          deliveredText: message,
          result_status: status,
          latency_ms: Date.now() - t0,
          cache_hit: true,
          session_id,
        });
        return {
          text: message,
          status,
          context_id: dup.context_id,
          metrics: {
            original_tokens: estimateTokens(originalText),
            delivered_tokens: estimateTokens(message),
            saved_tokens: estimateTokens(originalText) - estimateTokens(message),
            saved_ratio: 1,
          },
        };
      }
      const stored = getStoredBody(resource_id);
      if (delta_read && stored && stored !== originalText) {
        const hunks = diffLineRanges(stored, originalText);
        const deltaBody = formatDeltaHunks(resource_id, hunks);
        const header = [
          `gate: TOOL_RESULT | policy: ${POLICY_VERSION}`,
          `status: PARTIAL_DELTA | resource: ${resource_id} | hash: ${snap.hash}`,
          `file_mtime: ${snap.mtimeMs}`,
        ].join("\n");
        const deliveredText = `${header}\n\n${deltaBody}`;
        registerDeliveredContent(resource_id, originalText, { forceNew: true });
        const evt = recordFromText({
          source_type: source_type || "file",
          source_id: resource_id,
          originalText,
          deliveredText,
          result_status: "PARTIAL_DELTA",
          latency_ms: Date.now() - t0,
          session_id,
        });
        return {
          text: deliveredText,
          status: "PARTIAL_DELTA",
          kind: "code",
          metrics: {
            original_tokens: evt.original_tokens,
            delivered_tokens: evt.delivered_tokens,
            saved_tokens: evt.saved_tokens,
            saved_ratio: evt.saved_ratio,
            latency_ms: evt.latency_ms,
          },
        };
      }
    }
  }

  if (!originalText.trim()) {
    const empty = "status: NEW_CONTENT | empty payload";
    recordFromText({
      source_type,
      source_id: resource_id,
      originalText: "",
      deliveredText: empty,
      result_status: "EMPTY",
      latency_ms: Date.now() - t0,
      session_id,
    });
    return {
      text: empty,
      status: "NEW_CONTENT",
      metrics: { original_tokens: 0, delivered_tokens: 0, saved_tokens: 0, saved_ratio: 0 },
    };
  }

  if (dedup) {
    const dup = checkBeforeDeliver(resource_id, originalText);
    if (dup) {
      recordFromText({
        source_type,
        source_id: resource_id,
        originalText,
        deliveredText: dup.message,
        result_status: dup.status,
        latency_ms: Date.now() - t0,
        cache_hit: true,
        session_id,
      });
      return {
        text: dup.message,
        status: dup.status,
        context_id: dup.context_id,
        metrics: {
          original_tokens: estimateTokens(originalText),
          delivered_tokens: estimateTokens(dup.message),
          saved_tokens: estimateTokens(originalText) - estimateTokens(dup.message),
          saved_ratio: 1,
        },
      };
    }
  }

  const kind = detectContentKind(input.kind, originalText);
  let working = originalText;
  let compressionNote = "";
  /** @type {string[]} */
  let evidenceIds = [];
  /** @type {Record<string, unknown>} */
  let keyFacts = {};

  if (kind === "sql") {
    try {
      const parsed = normalizeSqlResult(JSON.parse(originalText));
      const r = compressSqlResult(parsed);
      if (r.compressed) {
        working = r.text;
        compressionNote = "sql_aggregate";
        if (r.source_ref) evidenceIds.push(r.source_ref);
        try {
          const summary = JSON.parse(working);
          keyFacts = {
            row_count: summary.row_count,
            schema_cols: summary.schema?.length,
          };
        } catch {
          /* ignore */
        }
      }
    } catch {
      const r = compressSqlResult(originalText);
      if (r.compressed) {
        working = r.text;
        compressionNote = "sql_aggregate";
        if (r.source_ref) evidenceIds.push(r.source_ref);
      }
    }
  } else if (kind === "json") {
    const r = compressJsonText(originalText, max_tokens);
    working = r.text;
    if (r.compressed) compressionNote = "json_shrink";
  } else if (kind === "log") {
    const r = compressLogText(originalText, max_tokens);
    working = r.text;
    if (r.compressed) compressionNote = "log_window";
  }

  const budgeted = budgetTruncate(working, max_tokens);
  working = budgeted.text;
  evidenceIds = [...new Set([...evidenceIds, ...extractEvidenceIds(working)])];

  const reg = dedup
    ? registerDeliveredContent(resource_id, originalText, { forceNew: false })
    : {
        status: "NEW_CONTENT",
        context_id: undefined,
        message: "status: NEW_CONTENT",
      };

  const header = [
    `gate: TOOL_RESULT | policy: ${POLICY_VERSION}`,
    reg.message,
    compressionNote ? `compression: ${compressionNote}` : "",
    budgeted.truncated ? "budget: truncated" : `budget: max_tokens=${max_tokens}`,
    `kind: ${kind}`,
  ]
    .filter(Boolean)
    .join("\n");

  const bodyBlock = wrapIfSaves(
    {
      body: working,
      evidence_ids: evidenceIds,
      truncated: budgeted.truncated,
      key_facts: Object.keys(keyFacts).length ? keyFacts : undefined,
    },
    estimateTokens,
  );
  const deliveredText = `${header}\n\n${bodyBlock}`;
  const evt = recordFromText({
    source_type,
    source_id: resource_id,
    originalText,
    deliveredText,
    result_status: reg.status,
    latency_ms: Date.now() - t0,
    session_id,
  });

  return {
    text: deliveredText,
    status: reg.status,
    context_id: reg.context_id,
    kind,
    evidence_ids: evidenceIds,
    metrics: {
      original_tokens: evt.original_tokens,
      delivered_tokens: evt.delivered_tokens,
      saved_tokens: evt.saved_tokens,
      saved_ratio: evt.saved_ratio,
      latency_ms: evt.latency_ms,
    },
  };
}
