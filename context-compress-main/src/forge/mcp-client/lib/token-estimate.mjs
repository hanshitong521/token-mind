/**
 * Rough token estimate (~4 chars/token for mixed EN/CN/code).
 * @param {string} text
 */
export function estimateTokens(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(s, "utf8") / 4));
}
