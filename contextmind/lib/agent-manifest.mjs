import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { routeStack } from "./stack-router.mjs";
import { loadTaskBundle, taskFilePath } from "./task-bundle.mjs";

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

export function buildAgentManifest(projectRoot, opts = {}) {
	const cfg = opts.cfg ?? {};
	const gate = readJson(join(projectRoot, ".requirementmind", "gate.json"));
	const decisions = readJson(join(projectRoot, ".requirementmind", "decisions.json"));
	const frozen = Array.isArray(decisions)
		? decisions.filter((d) => d?.status === "FROZEN").map((d) => d.id)
		: [];
	const route = routeStack(projectRoot, { cfg });
	const loaded = loadTaskBundle(projectRoot, cfg);
	const tf = taskFilePath(projectRoot, cfg);
	return {
		version: 1,
		route: route.first,
		what: {
			gate_ready: gate?.status === "READY_FOR_DEVELOPMENT",
			frozen_dec_ids: frozen,
			task_file: existsSync(tf) ? tf : null,
			goal: loaded?.bundle?.intent?.goal ?? null,
		},
	};
}

export function writeAgentManifest(projectRoot, opts = {}) {
	const manifest = buildAgentManifest(projectRoot, opts);
	mkdirSync(join(projectRoot, ".agent"), { recursive: true });
	const path = join(projectRoot, ".agent", "manifest.json");
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	return { path, manifest };
}
