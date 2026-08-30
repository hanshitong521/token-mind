import { registerSqlResultSnapshot, registerRawPayload } from "./evidence-store.mjs";

const ROW_THRESHOLD = Number(process.env.SQL_COMPRESS_ROW_THRESHOLD || 20);
const BYTE_THRESHOLD = Number(process.env.SQL_COMPRESS_BYTE_THRESHOLD || 4096);

/**
 * @param {unknown} data
 * @returns {{ columns: string[], rows: Record<string, unknown>[] }}
 */
export function normalizeSqlResult(data) {
  if (Array.isArray(data)) {
    if (!data.length) return { columns: [], rows: [] };
    const columns = Object.keys(data[0] || {});
    return { columns, rows: data };
  }
  if (data && typeof data === "object") {
    const o = /** @type {Record<string, unknown>} */ (data);
    if (Array.isArray(o.rows)) {
      const rows = /** @type {Record<string, unknown>[]} */ (o.rows);
      let columns = /** @type {string[]} */ (o.columns || o.fields);
      if (!columns?.length && rows[0]) {
        columns = Object.keys(rows[0]);
      }
      return { columns: columns || [], rows };
    }
    if (Array.isArray(o.data)) {
      return normalizeSqlResult(o.data);
    }
  }
  return { columns: [], rows: [] };
}

function isNumericValue(v) {
  if (v == null || v === "") return false;
  if (typeof v === "number" && Number.isFinite(v)) return true;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return true;
  return false;
}

function toNumber(v) {
  if (typeof v === "number") return v;
  return Number(String(v).trim());
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string[]} columns
 */
export function computeColumnStats(rows, columns) {
  /** @type {Record<string, { min?: number, max?: number, avg?: number, distinct_count?: number }>} */
  const stats = {};
  for (const col of columns) {
    const nums = [];
    const distinct = new Set();
    for (const row of rows) {
      const v = row[col];
      if (v !== undefined) distinct.add(v === null ? "__NULL__" : String(v));
      if (isNumericValue(v)) nums.push(toNumber(v));
    }
    if (!nums.length && distinct.size === 0) continue;
    const entry = { distinct_count: distinct.size };
    if (nums.length) {
      let sum = 0;
      let min = nums[0];
      let max = nums[0];
      for (const n of nums) {
        sum += n;
        if (n < min) min = n;
        if (n > max) max = n;
      }
      entry.min = min;
      entry.max = max;
      entry.avg = Math.round((sum / nums.length) * 1e6) / 1e6;
    }
    stats[col] = entry;
  }
  return stats;
}

/**
 * @param {{ columns: string[], rows: Record<string, unknown>[] }} parsed
 */
export function shouldCompressSqlResult(parsed) {
  const raw = JSON.stringify(parsed);
  return (
    parsed.rows.length > ROW_THRESHOLD || Buffer.byteLength(raw, "utf8") > BYTE_THRESHOLD
  );
}

function buildSampleRows(rows) {
  if (rows.length <= 5) return rows;
  const head = rows.slice(0, 3);
  const tail = rows.slice(-2);
  if (head.length + tail.length >= rows.length) return rows;
  return [...head, { __omitted_rows__: rows.length - 5 }, ...tail];
}

/**
 * Rule-based SQL result compression (no LLM). Large payloads register full snapshot for get_evidence.
 *
 * @param {unknown} data
 * @param {{ register?: boolean }} [options]
 */
export function compressSqlResult(data, options = {}) {
  const parsed = normalizeSqlResult(data);
  const fullJson = JSON.stringify({ columns: parsed.columns, rows: parsed.rows });
  const byteSize = Buffer.byteLength(fullJson, "utf8");

  if (!shouldCompressSqlResult(parsed)) {
    return {
      compressed: false,
      text: fullJson,
      byteSize,
      row_count: parsed.rows.length,
    };
  }

  const register = options.register !== false;
  const source_ref = register
    ? registerSqlResultSnapshot(parsed.columns, parsed.rows)
    : undefined;

  const payload = {
    schema: parsed.columns,
    row_count: parsed.rows.length,
    sample_rows: buildSampleRows(parsed.rows),
    stats: computeColumnStats(parsed.rows, parsed.columns),
    source_ref: source_ref || "query_id=unregistered",
    hint: "完整数据请用 get_evidence(id) 传入 source_ref 中的 F-xxxx",
  };

  const text = JSON.stringify(payload);
  return {
    compressed: true,
    text,
    byteSize: Buffer.byteLength(text, "utf8"),
    originalByteSize: byteSize,
    row_count: parsed.rows.length,
    source_ref,
    ratio: byteSize > 0 ? text.length / fullJson.length : 1,
  };
}

export function truncateWithEvidenceHint(text, maxChars = 2000) {
  const s = String(text || "");
  if (s.length <= maxChars) return s;
  const id = registerRawPayload("truncated", s);
  return (
    s.slice(0, maxChars) +
    `\n\n[TRUNCATED, use get_evidence(${id}) for full payload]`
  );
}
