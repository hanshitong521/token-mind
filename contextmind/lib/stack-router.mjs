/**
 * Stack router — one command answers “which layer first?” from disk state.
 * Fail-closed on ambiguous WHAT; micro waiver is explicit, not silent skip.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTaskBundle, taskFilePath } from "./task-bundle.mjs";

function readJson(path, fallback = null) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

export function waiverPath(projectRoot) {
	return join(projectRoot, ".contextmind", "waiver.json");
}

/** @returns {{ ok: boolean, reason?: string, waiver?: object }} */
export function loadWaiver(projectRoot) {
	const path = waiverPath(projectRoot);
	if (!existsSync(path)) return { ok: false, reason: "no waiver" };
	const w = readJson(path);
	if (!w || typeof w !== "object") return { ok: false, reason: "invalid waiver json" };
	if (!String(w.reason || "").trim()) return { ok: false, reason: "waiver.reason required" };
	if (!String(w.verify || "").trim()) return { ok: false, reason: "waiver.verify required" };
	if (w.expires) {
		const t = Date.parse(w.expires);
		if (Number.isFinite(t) && t < Date.now()) return { ok: false, reason: "waiver expired" };
	}
	return { ok: true, waiver: w };
}

function gateStatus(projectRoot) {
	const g = readJson(join(projectRoot, ".requirementmind", "gate.json"));
	if (!g) return { ready: false, status: "ABSENT" };
	const status = String(g.status || "");
	return { ready: status === "READY_FOR_DEVELOPMENT", status, gate: g };
}

function hasHandoffHint(projectRoot, bundle) {
	if (bundle?.meta?.source === "handoff") return true;
	if (bundle?.meta?.handoff_type) return true;
	const candidates = [
		join(projectRoot, ".contextmind", "handoff.yaml"),
		join(projectRoot, ".contextmind", "handoff.yml"),
		join(projectRoot, "docs", "handoff.yaml"),
	];
	return candidates.some((p) => existsSync(p));
}

/**
 * @param {string} projectRoot
 * @param {{ cfg?: object, signal?: string }} [opts]
 * @returns {object} route decision
 */
export function routeStack(projectRoot, opts = {}) {
	const cfg = opts.cfg ?? {};
	const signal = String(opts.signal || "").toLowerCase();
	const gate = gateStatus(projectRoot);
	const loaded = loadTaskBundle(projectRoot, cfg);
	const bundle = loaded?.bundle ?? null;
	const hasTask = Boolean(bundle?.intent?.goal);
	const waiver = loadWaiver(projectRoot);
	const handoff = hasHandoffHint(projectRoot, bundle);

	// Explicit signal overrides soft defaults
	if (/模糊|澄清|requirement|gate|多解读|金标/.test(signal) && !gate.ready) {
		return decide("requirement-mind", "signal asks WHAT and Gate not READY", { gate, hasTask, handoff, waiver });
	}
	if (/当初|为啥|adr|坑|why/.test(signal)) {
		return decide("project-brain", "WHY / memory signal", { gate, hasTask, handoff, waiver });
	}
	if (/design|怎么做|handoff|方案/.test(signal) && gate.ready && !handoff) {
		return decide("ai-design", "HOW not pinned after Gate READY", { gate, hasTask, handoff, waiver });
	}

	if (waiver.ok && (!hasTask || bundle?.meta?.source === "waiver" || bundle?.meta?.micro)) {
		return decide("ai-code", "micro waiver present — skip design, still SELF-CHECK", {
			gate,
			hasTask,
			handoff,
			waiver,
			micro: true,
		});
	}

	if (!gate.ready && !waiver.ok) {
		const session = readJson(join(projectRoot, ".requirementmind", "session.json"));
		if (session || existsSync(join(projectRoot, ".requirementmind", "questions.json"))) {
			return decide("requirement-mind", "Gate not READY — finish WHAT first", { gate, hasTask, handoff, waiver });
		}
	}

	if (gate.ready && !handoff && !hasTask && !waiver.ok) {
		return decide("ai-design", "Gate READY but no Handoff/TaskBundle", { gate, hasTask, handoff, waiver });
	}

	if (hasTask || (gate.ready && handoff)) {
		return decide("ai-code", "TaskBundle/Handoff present — implement + SELF-CHECK", {
			gate,
			hasTask,
			handoff,
			waiver,
			task_file: taskFilePath(projectRoot, cfg),
			goal: bundle?.intent?.goal ?? null,
		});
	}

	if (waiver.ok) {
		return decide("ai-code", "waiver-only micro path", { gate, hasTask, handoff, waiver, micro: true });
	}

	return decide("ai-design", "default: pin HOW before DO", { gate, hasTask, handoff, waiver });
}

function decide(first, reason, ctx) {
	const forbid = {
		"requirement-mind": ["/ai-code", "grilling-as-style"],
		"ai-design": ["/ai-code same chat", "re-ask FROZEN"],
		"ai-code": ["@grilling", "skip SELF-CHECK"],
		"project-brain": ["as CodeGraph", "override FROZEN"],
	};
	return {
		first,
		reason,
		forbid: forbid[first] ?? [],
		gate_status: ctx.gate?.status ?? "ABSENT",
		gate_ready: Boolean(ctx.gate?.ready),
		has_task: Boolean(ctx.hasTask),
		has_handoff: Boolean(ctx.handoff),
		micro: Boolean(ctx.micro),
		waiver_ok: Boolean(ctx.waiver?.ok),
		goal: ctx.goal ?? null,
		task_file: ctx.task_file ?? null,
		invoke: invokeHint(first, ctx),
	};
}

function invokeHint(first, ctx) {
	switch (first) {
		case "requirement-mind":
			return "/requirement-mind (Phase3 grilling until Gate READY)";
		case "ai-design":
			return "/ai-design → validate_handoff → handoff_to_task_bundle";
		case "ai-code":
			return ctx.micro
				? "/ai-code (micro: G0 one-line判据 + waiver.verify)"
				: "/ai-code (orient1 → diff → SELF-CHECK)";
		case "project-brain":
			return "MCP search_project_context / get_change_context";
		default:
			return first;
	}
}

/** Compact injection for sessionStart (token-capped by caller). */
export function formatRoutePreamble(route, maxChars = 280) {
	if (!route) return "";
	const lines = [
		`[StackRoute] first=${route.first}`,
		`reason: ${route.reason}`,
		`invoke: ${route.invoke}`,
		`gate=${route.gate_status} task=${route.has_task ? "yes" : "no"} handoff=${route.has_handoff ? "yes" : "no"} micro=${route.micro ? "yes" : "no"}`,
		route.forbid?.length ? `forbid: ${route.forbid.join("; ")}` : "",
	].filter(Boolean);
	const text = lines.join("\n");
	return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
