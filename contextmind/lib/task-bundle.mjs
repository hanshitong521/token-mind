import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const ACTIVE = "task.active.json";

function resolveUnderProject(projectRoot, p) {
	const s = String(p ?? "").trim();
	if (!s) return join(projectRoot, ".contextmind", ACTIVE);
	return isAbsolute(s) ? resolve(s) : join(projectRoot, s);
}

export function taskFilePath(projectRoot, cfg = {}) {
	if (cfg?.sdlc?.task_file) return resolveUnderProject(projectRoot, cfg.sdlc.task_file);
	return join(projectRoot, ".contextmind", ACTIVE);
}

export function executionLogPath(projectRoot, _cfg = {}) {
	return join(projectRoot, ".contextmind", "execution.jsonl");
}

export function globMatch(filePath, pattern) {
	const norm = String(filePath ?? "").replace(/\\/g, "/");
	const pat = String(pattern ?? "").replace(/\\/g, "/");
	if (!pat) return false;
	if (pat.endsWith("/**")) {
		const prefix = pat.slice(0, -3);
		return norm === prefix || norm.startsWith(`${prefix}/`);
	}
	const re = new RegExp(
		`^${pat
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*\*/g, ".*")
			.replace(/\*/g, "[^/]*")}$`,
	);
	return re.test(norm);
}

export function validateTaskBundleRaw(raw) {
	if (!raw || typeof raw !== "object") return { ok: false, error: "not an object" };
	const bundle = { ...raw };
	if (raw.schema_version === 2 || raw.task_id) {
		bundle.id = raw.task_id ?? raw.id ?? "task";
		if (raw.requirement) bundle.requirement = raw.requirement;
		if (!String(bundle.intent?.goal ?? "").trim()) return { ok: false, error: "intent.goal required" };
		return { ok: true, bundle };
	}
	if (!String(bundle.intent?.goal ?? "").trim()) return { ok: false, error: "intent.goal required" };
	bundle.version = bundle.version ?? 1;
	return { ok: true, bundle };
}

export function loadTaskBundle(projectRoot, cfg = {}) {
	const path = taskFilePath(projectRoot, cfg);
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		const v = validateTaskBundleRaw(raw);
		if (!v.ok) return { path, error: v.error };
		return { path, bundle: v.bundle };
	} catch (e) {
		return { path, error: String(e) };
	}
}

export function taskIdFromLoaded(loaded) {
	const b = loaded?.bundle;
	if (!b) return null;
	return b.id ?? b.task_id ?? b.meta?.task_id ?? null;
}

export function evaluatePathScope({ filePath, projectRoot, bundle, enforceAllow = true }) {
	const rel = relative(projectRoot, filePath).replace(/\\/g, "/");
	const spec = bundle?.spec ?? {};
	for (const g of spec.deny_globs ?? []) {
		if (globMatch(rel, g)) {
			return { decision: "deny", rule: "task_deny_glob", reason: `path denied by ${g}` };
		}
	}
	const allow = spec.allow_globs ?? [];
	if (enforceAllow && allow.length > 0) {
		const ok = allow.some((g) => globMatch(rel, g));
		if (!ok) {
			return { decision: "deny", rule: "task_allow_glob", reason: "path outside allow_globs" };
		}
	}
	return { decision: "allow", rule: "task_scope" };
}

export function appendExecutionRecord(projectRoot, cfg, record) {
	const path = executionLogPath(projectRoot, cfg);
	mkdirSync(join(projectRoot, ".contextmind"), { recursive: true });
	appendFileSync(path, `${JSON.stringify({ ...record, ts: Date.now() })}\n`, "utf8");
}

/** CLI / peak-gate: validate active TaskBundle on disk. */
export function validateActiveTaskBundle(projectRoot, cfg = {}) {
	const loaded = loadTaskBundle(projectRoot, cfg);
	if (!loaded) return { ok: false, error: "no task bundle", path: taskFilePath(projectRoot, cfg) };
	if (loaded.error) return { ok: false, error: loaded.error, path: loaded.path };
	const v = validateTaskBundleRaw(loaded.bundle);
	if (!v.ok) return { ok: false, error: v.error, path: loaded.path };
	return { ok: true, path: loaded.path, bundle: v.bundle };
}
