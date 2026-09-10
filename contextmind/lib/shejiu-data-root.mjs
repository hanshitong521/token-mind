/**
 * Unified off-repo data layout under SHEJIU_DATA_ROOT (default D:\shejiu-data on Windows).
 *
 *   <root>/project-brain/     — Brain memories, stats, aliases
 *   <root>/projects/<key>/contextmind/  — telemetry, handles, tasks, episodic memory
 *   <root>/projects/<key>/forgemind/    — MCP activity journal
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const DEFAULT_WIN = "D:\\shejiu-data";

export function shejiuDataRoot() {
	const raw = process.env.SHEJIU_DATA_ROOT?.trim();
	if (raw) return resolve(raw);
	if (process.platform === "win32") return resolve(DEFAULT_WIN);
	return resolve(process.env.HOME || process.env.USERPROFILE || ".", "shejiu-data");
}

export function projectDataKey(projectDir, cfg = null) {
	const fromCfg = cfg?.brain?.project_id || cfg?.data_root?.project_key;
	if (fromCfg && String(fromCfg).trim()) return String(fromCfg).trim();
	const cfgPath = join(projectDir, ".contextmind.json");
	if (existsSync(cfgPath)) {
		try {
			const j = JSON.parse(readFileSync(cfgPath, "utf8"));
			const id = j?.brain?.project_id;
			if (id && String(id).trim()) return String(id).trim();
		} catch {
			/* */
		}
	}
	return basename(resolve(projectDir));
}

export function projectContextMindDir(projectDir, cfg = null) {
	const key = projectDataKey(projectDir, cfg);
	return join(shejiuDataRoot(), "projects", key, "contextmind");
}

export function projectForgemindDir(projectDir, cfg = null) {
	const key = projectDataKey(projectDir, cfg);
	return join(shejiuDataRoot(), "projects", key, "forgemind");
}

/** Remap ContextMind cfg paths to SHEJIU_DATA_ROOT (unless CONTEXTMIND_TELEMETRY_DB set). */
export function applyShejiuDataPaths(cfg, projectDir) {
	if (process.env.CONTEXTMIND_TELEMETRY_DB?.trim()) return cfg;
	const cm = projectContextMindDir(projectDir, cfg);
	const fg = projectForgemindDir(projectDir, cfg);
	cfg.telemetry = { ...cfg.telemetry, db: join(cm, "telemetry.db") };
	cfg.sdlc = {
		...cfg.sdlc,
		task_file: join(cm, "task.active.json"),
		execution_log: join(cm, "execution.jsonl"),
	};
	cfg.memory = {
		...cfg.memory,
		episodic_file: join(cm, "memory", "episodic.jsonl"),
	};
	cfg.shejiu_data = {
		root: shejiuDataRoot(),
		project_key: projectDataKey(projectDir, cfg),
		contextmind_dir: cm,
		forgemind_dir: fg,
		brain_dir: join(shejiuDataRoot(), "project-brain"),
	};
	return cfg;
}
