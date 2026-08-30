import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * @typedef {{ hash: string, mtimeMs: number, size: number, body: string }} FileSnapshot
 */

const WIN_DEVICE_RE = /^\\\\\.\\/;
const UNC_RE = /^\\\\[^\\]+\\/i;

/**
 * Allowed roots for gate_tool_result file_path reads (semicolon-separated on Windows).
 * Fail-closed: no roots → all file_path reads denied.
 */
export function resolveGateReadRoots() {
  const raw =
    process.env.TOKEN_SKILL_GATE_READ_ROOTS ||
    process.env.TOKEN_SKILL_WORKSPACE ||
    "";
  return raw
    .split(/[;|]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

/**
 * @param {string} filePath
 * @returns {string}
 */
export function assertGateReadPath(filePath) {
  const roots = resolveGateReadRoots();
  if (!roots.length) {
    throw new Error("path_escape: GATE read roots not configured (TOKEN_SKILL_GATE_READ_ROOTS)");
  }
  const raw = String(filePath || "").trim();
  if (!raw || raw.includes("\0")) {
    throw new Error("path_escape: invalid path");
  }
  if (WIN_DEVICE_RE.test(raw) || UNC_RE.test(raw)) {
    throw new Error("path_escape: UNC or device paths not allowed");
  }
  let resolved = path.resolve(raw);
  let real;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    throw new Error("path_escape: path not found");
  }
  resolved = real;
  const ok = roots.some((base) => {
    const b = fs.realpathSync.native ? fs.realpathSync.native(base) : fs.realpathSync(base);
    return resolved === b || resolved.startsWith(b + path.sep);
  });
  if (!ok) {
    throw new Error(`path_escape: ${resolved} is outside gate read roots`);
  }
  return resolved;
}

/**
 * @param {string} filePath
 * @returns {FileSnapshot | null}
 */
export function readFileSnapshot(filePath) {
  let resolved;
  try {
    resolved = assertGateReadPath(filePath);
  } catch {
    return null;
  }
  if (!resolved || !fs.existsSync(resolved)) return null;
  const st = fs.statSync(resolved);
  if (!st.isFile()) return null;
  const body = fs.readFileSync(resolved, "utf8");
  const hash = crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
  return { hash, mtimeMs: st.mtimeMs, size: st.size, body };
}

/**
 * Line-level diff for changed files (simple unified-style hunks).
 * @param {string} oldText
 * @param {string} newText
 * @param {number} [contextLines]
 */
export function diffLineRanges(oldText, newText, contextLines = 2) {
  const oldL = String(oldText).split(/\r?\n/);
  const newL = String(newText).split(/\r?\n/);
  const max = Math.max(oldL.length, newL.length);
  /** @type {{ start: number, end: number, lines: string[] }[]} */
  const hunks = [];
  let i = 0;
  while (i < max) {
    const changed =
      (oldL[i] ?? "") !== (newL[i] ?? "") ||
      (i < max - 1 && (oldL[i + 1] ?? "") !== (newL[i + 1] ?? ""));
    if (!changed) {
      i += 1;
      continue;
    }
    const start = Math.max(0, i - contextLines);
    let end = i;
    while (end < max && (oldL[end] ?? "") !== (newL[end] ?? "")) end += 1;
    end = Math.min(max, end + contextLines);
    const lines = [];
    for (let j = start; j < end; j++) {
      const o = oldL[j];
      const n = newL[j];
      if (o === n) lines.push(` ${n ?? ""}`);
      else {
        if (o !== undefined) lines.push(`-${o}`);
        if (n !== undefined) lines.push(`+${n}`);
      }
    }
    hunks.push({ start: start + 1, end, lines });
    i = end;
  }
  return hunks;
}

export function formatDeltaHunks(resourceId, hunks) {
  if (!hunks.length) return `status: UNCHANGED | resource: ${resourceId}`;
  const parts = hunks.slice(0, 12).map((h) => {
    return [`@@ ${resourceId}:${h.start}-${h.end} @@`, ...h.lines].join("\n");
  });
  if (hunks.length > 12) parts.push(`…[+${hunks.length - 12} more hunks]`);
  return parts.join("\n\n");
}
