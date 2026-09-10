import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function episodicPath(projectRoot, cfg) {
	const rel = cfg?.memory?.episodic_file ?? ".contextmind/memory/episodic.jsonl";
	return join(projectRoot, rel);
}

export function appendEpisodic(projectRoot, cfg, entry) {
	if (cfg?.memory?.episodic_enabled === false) return;
	const path = episodicPath(projectRoot, cfg);
	mkdirSync(dirname(path), { recursive: true });
	const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
	appendFileSync(path, `${line}\n`, "utf8");
}

export function readEpisodic(projectRoot, cfg, limit = 200) {
	const path = episodicPath(projectRoot, cfg);
	if (!existsSync(path)) return [];
	const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
	const out = [];
	for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
		try {
			out.push(JSON.parse(lines[i]));
		} catch {
			/* skip */
		}
	}
	return out;
}
