/**
 * Session-end evolution: append Project Brain memory + execution log marker.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { appendExecutionRecord, loadTaskBundle, taskIdFromLoaded } from "./task-bundle.mjs";

export const BRAIN_DEBOUNCE_MS = 30 * 60 * 1000;

function brainPython(cfg) {
	if (cfg?.brain?.python) return resolve(String(cfg.brain.python));
	const src = process.env.CONTEXTMIND_SOURCE_REPO
		? resolve(process.env.CONTEXTMIND_SOURCE_REPO)
		: null;
	if (src) {
		const win = join(resolve(src, "..", "project-brain-agent"), ".venv", "Scripts", "python.exe");
		if (existsSync(win)) return win;
		const posix = join(resolve(src, "..", "project-brain-agent"), ".venv", "bin", "python");
		if (existsSync(posix)) return posix;
	}
	return "python";
}

function brainAddScript(_cfg, projectRoot) {
	const candidates = [];
	const src = process.env.CONTEXTMIND_SOURCE_REPO
		? resolve(process.env.CONTEXTMIND_SOURCE_REPO)
		: null;
	if (src) {
		candidates.push(join(resolve(src, "..", "project-brain-agent"), "scripts", "brain-memory-add.py"));
	}
	candidates.push("E:/workA/A-skill/project-brain-agent/scripts/brain-memory-add.py");
	candidates.push(join(resolve(projectRoot), "scripts", "brain-memory-add.py"));
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return null;
}

export function brainSummaryKey(summary) {
	const norm = String(summary ?? "")
		.replace(/\s+Ledger:[\s\S]*$/, "")
		.trim();
	return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

/** True if this summary was already recorded within the debounce window (and records the attempt). */
export function consumeBrainDebounce(projectRoot, summary, now = Date.now(), windowMs = BRAIN_DEBOUNCE_MS) {
	const dir = join(projectRoot, ".contextmind");
	const p = join(dir, "brain-last-record.json");
	const key = brainSummaryKey(summary);
	try {
		const prev = JSON.parse(readFileSync(p, "utf8"));
		if (prev.key === key && Number.isFinite(Date.parse(prev.ts)) && now - Date.parse(prev.ts) < windowMs) {
			return true;
		}
	} catch {
		/* first write */
	}
	mkdirSync(dir, { recursive: true });
	writeFileSync(p, `${JSON.stringify({ key, ts: new Date(now).toISOString() })}\n`, "utf8");
	return false;
}

/**
 * @param {{ projectRoot: string, cfg: object, sessionId?: string, telemetry?: { sessionSummary?: (id: string) => object|null } }} opts
 */
export function maybeRecordSessionEvolution(opts) {
	const cfg = opts.cfg ?? {};
	const brain = cfg.brain ?? {};
	if (!brain.auto_record_on_session_end || !brain.project_id?.trim()) return { skipped: "disabled" };

	const loaded = loadTaskBundle(opts.projectRoot, cfg);
	const taskId = taskIdFromLoaded(loaded);
	const goal = loaded?.bundle?.intent?.goal?.trim() ?? "";
	if (!goal && !taskId) return { skipped: "no_task" };

	let savings = "";
	try {
		const sum = opts.telemetry?.sessionSummary?.(opts.sessionId ?? "");
		if (sum && typeof sum === "object") {
			const saved = Number(sum.tool_emitted_savings ?? 0);
			const blocked = Number(sum.read_blocked ?? 0);
			if (saved > 0 || blocked > 0) {
				savings = ` Ledger: tool_saved~${saved} tok; read_blocked=${blocked}.`;
			}
		}
	} catch {
		/* optional */
	}

	const summary = `[${taskId ?? "session"}] ${goal.slice(0, 280)}${savings}`.trim();
	if (consumeBrainDebounce(opts.projectRoot, summary)) {
		return { skipped: "debounce", summary };
	}

	appendExecutionRecord(opts.projectRoot, cfg, {
		type: "session_end",
		task_id: taskId,
		session_id: opts.sessionId ?? null,
		summary,
	});

	const script = brainAddScript(cfg, opts.projectRoot);
	if (!script) return { skipped: "no_brain_script", summary };

	const py = brainPython(cfg);
	const brainRoot = resolve(script, "..", "..");
	const meta = JSON.stringify({
		kind: "experience",
		task_id: taskId || "session",
		title: (goal || taskId || "session").slice(0, 72),
		session_id: opts.sessionId ?? null,
	});
	const r = spawnSync(
		py,
		[script, String(brain.project_id), summary, "medium", meta],
		{
			encoding: "utf8",
			timeout: 15_000,
			windowsHide: true,
			env: {
				...process.env,
				PYTHONPATH: join(brainRoot, "src"),
				PYTHONUTF8: "1",
			},
		},
	);
	if (r.status !== 0) return { ok: false, stderr: (r.stderr || "").slice(0, 400), summary };
	return { ok: true, summary, title: goal.slice(0, 72) || taskId || "session" };
}
