import crypto from "crypto";

const PEPPER = "ts-v1";

const DEFAULT_ROUTE_PAYLOAD = {
  health: "/health",
  projects: "/v1/projects",
  search: "/v1/search",
  jobs: "/v1/jobs",
};

/**
 * @param {{ apiBase: string, hostHeader?: string, rejectUnauthorized?: boolean, routes?: Record<string, string> }} cfg
 * @returns {string} opaque blob for TS_INLINE_EMBED
 */
export function encodeEndpointConfig(cfg) {
  const payload = JSON.stringify({
    a: cfg.apiBase.replace(/\/+$/, ""),
    h: (cfg.hostHeader || "").trim(),
    r: cfg.rejectUnauthorized !== false ? 1 : 0,
    t: { ...DEFAULT_ROUTE_PAYLOAD, ...(cfg.routes || {}) },
  });
  const seed = crypto.randomBytes(32);
  const key = crypto.createHash("sha256").update(seed).update(PEPPER).digest();
  const buf = Buffer.from(payload, "utf8");
  for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length];
  const wrap = {
    v: 1,
    p: [seed.toString("base64url"), buf.toString("base64url")],
    n: crypto.randomBytes(12).toString("hex"),
  };
  return Buffer.from(JSON.stringify(wrap)).toString("base64url");
}

/**
 * @param {string | undefined} blob
 * @returns {{ apiBase: string, hostHeader: string, rejectUnauthorized: boolean, routes: Record<string, string> | null } | null}
 */
export function decodeEndpointConfig(blob) {
  if (!blob || typeof blob !== "string" || !blob.length) return null;
  try {
    const wrap = JSON.parse(Buffer.from(blob, "base64url").toString("utf8"));
    if (wrap?.v !== 1 || !Array.isArray(wrap.p) || wrap.p.length < 2) return null;
    const seed = Buffer.from(wrap.p[0], "base64url");
    const key = crypto.createHash("sha256").update(seed).update(PEPPER).digest();
    const buf = Buffer.from(wrap.p[1], "base64url");
    for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length];
    const o = JSON.parse(buf.toString("utf8"));
    if (!o.a || typeof o.a !== "string") return null;
    return {
      apiBase: o.a,
      hostHeader: typeof o.h === "string" ? o.h : "",
      rejectUnauthorized: o.r !== 0,
      routes: o.t && typeof o.t === "object" ? o.t : null,
    };
  } catch {
    return null;
  }
}
