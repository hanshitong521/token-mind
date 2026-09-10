/**
 * SKILL.state — sync `.agent/state/*` from TaskBundle + shell_done in execution log.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { loadTaskBundle, taskFilePath, executionLogPath } from "./task-bundle.mjs";

export const AGENT_STATE_REL = ".agent/state";
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

export function agentStateDir(projectRoot) {
	return join(projectRoot, AGENT_STATE_REL);
}
export function projectStatePath(projectRoot) {
	return join(agentStateDir(projectRoot), "project_state.json");
}
export function taskStatePath(projectRoot) {
	return join(agentStateDir(projectRoot), "task_state.json");
}
export function decisionStatePath(projectRoot) {
	return join(agentStateDir(projectRoot), "decision_state.json");
}

function todayIso() {
	return new Date().toISOString().slice(0, 10);
}
function readJson(path, fallback = null) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}
function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function uniqStrings(arr) {
	const out = [];
	const seen = new Set();
	for (const x of arr ?? []) {
		const s = String(x ?? "").trim();
		if (!s || seen.has(s)) continue;
		seen.add(s);
		out.push(s);
	}
	return out;
}
function normCmd(s) {
	return String(s ?? "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

export function recentShellCommands(projectRoot, cfg, limit = 12) {
	const logPath = executionLogPath(projectRoot, cfg);
	if (!existsSync(logPath)) return [];
	const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
	const cmds = [];
	for (let i = lines.length - 1; i >= 0 && cmds.length < limit; i--) {
		try {
			const row = JSON.parse(lines[i]);
			if (row.kind === "shell_done") {
				if (row.exit_code !== 0 && row.exit_code != null) continue;
				if (row.command) cmds.push(String(row.command));
				continue;
			}
			if (row.kind === "shell" && row.command) cmds.push(String(row.command));
		} catch {
			/* skip */
		}
	}
	return cmds.reverse();
}

function recentSuccessfulEvalMatch(projectRoot, cfg, evalCommands) {
	const logPath = executionLogPath(projectRoot, cfg);
	if (!existsSync(logPath)) return null;
	const evals = (evalCommands ?? []).map(normCmd).filter(Boolean);
	if (!evals.length) return null;
	const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const row = JSON.parse(lines[i]);
			if (row.kind !== "shell_done" || row.exit_code !== 0 || !row.command) continue;
			const n = normCmd(row.command);
			for (const ev of evals) {
				if (n.includes(ev) || ev.includes(n.slice(0, Math.min(120, n.length)))) {
					return String(row.command).slice(0, 400);
				}
			}
		} catch {
			/* skip */
		}
	}
	return null;
}

function matchEvalCommand(shellCmds, evalCommands) {
	const evals = (evalCommands ?? []).map(normCmd).filter(Boolean);
	if (!evals.length || !shellCmds.length) return null;
	for (const cmd of shellCmds) {
		const n = normCmd(cmd);
		for (const ev of evals) {
			if (n.includes(ev) || ev.includes(n.slice(0, Math.min(80, n.length)))) return cmd.slice(0, 400);
		}
	}
	return null;
}

function inferPlanCursor(steps, shellCmds, prevCursor = 0) {
	if (!steps?.length) return prevCursor;
	let cursor = Math.max(0, Math.min(prevCursor, steps.length));
	for (let i = cursor; i < steps.length; i++) {
		const step = normCmd(steps[i]);
		const hit = shellCmds.some((c) => {
			const n = normCmd(c);
			return step && (n.includes(step.slice(0, 24)) || step.includes("mvn") === n.includes("mvn"));
		});
		if (hit) cursor = i + 1;
		else break;
	}
	return Math.min(cursor, steps.length);
}

export function validateProjectState(data) {
	const issues = [];
	if (!data || typeof data !== "object") return ["not an object"];
	if (data.version !== 1) issues.push("version must be 1");
	if (!data.goal || typeof data.goal !== "string") issues.push("goal required");
	if (data.updated && !DATE_RE.test(String(data.updated))) issues.push("updated must be YYYY-MM-DD");
	return issues;
}

export function validateTaskState(data) {
	const issues = [];
	if (!data || typeof data !== "object") return ["not an object"];
	if (data.version !== 1) issues.push("version must be 1");
	if (!data.phase) issues.push("phase required");
	return issues;
}

export function initAgentStateScaffold(projectRoot, { force = false } = {}) {
	mkdirSync(agentStateDir(projectRoot), { recursive: true });
	const files = [
		[projectStatePath(projectRoot), {
			version: 1,
			goal: "Set goal in .contextmind/task.active.json",
			completed: [],
			current: "Run: node .cursor/contextmind/cli.mjs state sync",
			constraints: [],
			blocked: [],
			rejected: [],
			links: { task_bundle: ".contextmind/task.active.json" },
			updated: todayIso(),
		}],
		[taskStatePath(projectRoot), {
			version: 1,
			phase: "implement",
			task_bundle_path: ".contextmind/task.active.json",
			plan_cursor: 0,
			last_verified: "",
			open_risks: [],
			updated: todayIso(),
		}],
		[decisionStatePath(projectRoot), { version: 1, decisions: [] }],
	];
	const written = [];
	for (const [path, body] of files) {
		if (existsSync(path) && !force) continue;
		writeJson(path, body);
		written.push(path);
	}
	return { written, skipped: files.length - written.length };
}

export function syncAgentStateFromTaskBundle(projectRoot, cfg, opts = {}) {
	const loaded = loadTaskBundle(projectRoot, cfg);
	if (!loaded?.bundle) return { ok: false, reason: loaded?.error ?? "no_bundle" };

	const b = loaded.bundle;
	const relTask = relative(projectRoot, taskFilePath(projectRoot, cfg)).replace(/\\/g, "/");
	const shellCmds = recentShellCommands(projectRoot, cfg);

	let project = readJson(projectStatePath(projectRoot), null);
	if (!project) {
		initAgentStateScaffold(projectRoot);
		project = readJson(projectStatePath(projectRoot), {});
	}

	let task = readJson(taskStatePath(projectRoot), null);
	if (!task) {
		task = {
			version: 1,
			phase: "implement",
			task_bundle_path: relTask,
			plan_cursor: 0,
			last_verified: "",
			open_risks: [],
		};
	}

	const steps = b.plan?.steps ?? [];
	const prevCursor = Number(task.plan_cursor ?? 0) || 0;
	const verified =
		recentSuccessfulEvalMatch(projectRoot, cfg, b.eval?.commands) ??
		matchEvalCommand(shellCmds, b.eval?.commands);
	let planCursor = inferPlanCursor(steps, shellCmds, prevCursor);
	if (verified) {
		task.last_verified = verified;
		if (steps.length) planCursor = steps.length;
		else planCursor = Math.max(planCursor, prevCursor + 1);
	}

	task.plan_cursor = planCursor;
	task.task_bundle_path = relTask;
	task.updated = todayIso();

	if (planCursor > 0 && steps.length) {
		project.completed = uniqStrings([...(project.completed ?? []), ...steps.slice(0, planCursor)]);
	}

	project.version = 1;
	project.goal = b.intent.goal.trim();
	project.constraints = uniqStrings([...(project.constraints ?? []), ...(b.spec?.forbidden_actions ?? [])]);
	project.links = { ...(project.links ?? {}), task_bundle: relTask };
	if (steps.length) {
		project.current =
			planCursor >= steps.length
				? (b.eval?.acceptance?.trim() || "plan steps done — run eval.commands")
				: steps[planCursor];
	} else if (!project.current?.trim()) {
		project.current = b.intent.success?.trim() || "implement per TaskBundle";
	}
	if (opts.sessionId) project.last_session_id = String(opts.sessionId);
	project.updated = todayIso();

	writeJson(projectStatePath(projectRoot), project);
	writeJson(taskStatePath(projectRoot), task);

	return { ok: true, project, task, plan_cursor: planCursor };
}

export function formatAgentStatePreamble(projectRoot, maxChars = 320) {
	const p = readJson(projectStatePath(projectRoot), null);
	if (!p?.goal) return "";
	const lines = ["[AgentState]", `current: ${String(p.current ?? "—").slice(0, 160)}`];
	if (p.blocked?.length) lines.push(`blocked: ${p.blocked.slice(0, 3).join("; ")}`);
	let text = lines.join("\n");
	if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
	return text;
}

export function validateAgentStateFiles(projectRoot) {
	const issues = [];
	for (const [label, path, fn] of [
		["project_state", projectStatePath(projectRoot), validateProjectState],
		["task_state", taskStatePath(projectRoot), validateTaskState],
	]) {
		if (!existsSync(path)) {
			issues.push(`${label}: missing ${path}`);
			continue;
		}
		const errs = fn(readJson(path, null));
		if (errs.length) issues.push(`${label}: ${errs.join("; ")}`);
	}
	return issues;
}
