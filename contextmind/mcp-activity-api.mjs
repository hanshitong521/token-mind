/**
 * Read/write MCP activity journal (.forgemind) for ContextMind dashboard /mcp-lab.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const JOURNAL = join(".forgemind", "mcp-activity.jsonl");
const META = join(".forgemind", "mcp-activity-meta.json");

function readMeta(projectRoot) {
	const p = join(projectRoot, META);
	if (!existsSync(p)) return { version: 1, annotations: {}, compressed_lessons: [] };
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return { version: 1, annotations: {}, compressed_lessons: [] };
	}
}

function writeMeta(projectRoot, meta) {
	const dir = join(projectRoot, ".forgemind");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(join(projectRoot, META), JSON.stringify(meta, null, 2), "utf8");
}

function readJournal(projectRoot, limit = 200) {
	const p = join(projectRoot, JOURNAL);
	if (!existsSync(p)) return [];
	const lines = readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean);
	const tail = lines.slice(-limit);
	const entries = [];
	for (const line of tail) {
		try {
			const row = JSON.parse(line);
			if (isDemoEntry(row)) continue;
			entries.push(row);
		} catch {
			/* skip */
		}
	}
	return entries.reverse();
}

function isDemoEntry(e) {
	if (e?.demo === true) return true;
	const id = String(e?.id ?? "");
	if (id.startsWith("demo-")) return true;
	if (String(e?.session_id ?? "").startsWith("demo-session")) return true;
	return false;
}

function resolveAlignment(projectRoot) {
	const warnings = [];
	let primary = null;
	const overridePath = join(projectRoot, ".forgemind", "primary-project.json");
	if (existsSync(overridePath)) {
		try {
			const o = JSON.parse(readFileSync(overridePath, "utf8"));
			if (o.primaryProjectRoot) primary = resolve(o.primaryProjectRoot);
		} catch {
			/* */
		}
	}
	const mcpPath = join(projectRoot, ".cursor", "mcp.json");
	if (existsSync(mcpPath)) {
		try {
			const cfg = JSON.parse(readFileSync(mcpPath, "utf8"));
			const dirs = new Set();
			for (const srv of Object.values(cfg.mcpServers ?? {})) {
				for (const key of ["LABOR_PROJECT_DIR", "CONTEXTMIND_PROJECT_DIR"]) {
					const v = srv?.env?.[key];
					if (v) dirs.add(resolve(String(v)));
				}
			}
			if (!primary && dirs.size === 1) primary = [...dirs][0];
			if (!primary && dirs.size > 1) {
				warnings.push("MCP project dirs disagree — set .forgemind/primary-project.json");
				primary = [...dirs][0];
			}
		} catch {
			/* */
		}
	}
	const cwd = resolve(projectRoot);
	const aligned = !primary || cwd.toLowerCase() === primary.toLowerCase();
	return { workspaceCwd: cwd, primaryProjectRoot: primary, aligned, warnings };
}

export function getMcpActivityBundle(projectRoot, limit = 200) {
	const meta = readMeta(projectRoot);
	const entries = readJournal(projectRoot, limit).map((e) => ({
		...e,
		annotation: meta.annotations[e.id] ?? null,
	}));
	return {
		alignment: resolveAlignment(projectRoot),
		entries,
		compressed_lessons: meta.compressed_lessons ?? [],
	};
}

export function annotateEntry(projectRoot, body) {
	const id = String(body.id ?? "");
	if (!id) throw new Error("id required");
	const meta = readMeta(projectRoot);
	const prev = meta.annotations[id] ?? {};
	meta.annotations[id] = {
		verdict: body.verdict ?? prev.verdict ?? "unknown",
		resolved: body.resolved ?? prev.resolved ?? false,
		note: body.note ?? prev.note,
		adjustment: body.adjustment ?? prev.adjustment,
		archived: body.archived ?? prev.archived ?? false,
		archived_at: body.archived === true ? new Date().toISOString() : prev.archived_at,
		fixed_by_id: body.fixed_by_id ?? prev.fixed_by_id,
		supersedes_id: body.supersedes_id ?? prev.supersedes_id,
		updated_at: new Date().toISOString(),
	};
	writeMeta(projectRoot, meta);
	return meta.annotations[id];
}

export function compressLessons(projectRoot) {
	const meta = readMeta(projectRoot);
	const entries = readJournal(projectRoot, 500);
	const byKey = new Map((meta.compressed_lessons ?? []).map((l) => [l.key, l]));
	for (const entry of entries) {
		const ann = meta.annotations[entry.id];
		if (!ann?.archived || ann.verdict !== "wrong") continue;
		const key = `${entry.mcp_server_name}|${entry.tool_name}|${(entry.error ?? entry.envelope_status ?? "").slice(0, 80)}`;
		const lesson = ann.adjustment || ann.note || entry.error || entry.summary || "wrong MCP call";
		const existing = byKey.get(key);
		if (existing) {
			existing.wrong_count += 1;
			existing.last_seen = entry.at;
			existing.lesson = lesson;
			existing.adjustment = ann.adjustment;
		} else {
			byKey.set(key, {
				id: `lesson-${key.slice(0, 32).replace(/[^a-zA-Z0-9|_-]/g, "_")}`,
				key,
				server: entry.mcp_server_name,
				tool: entry.tool_name,
				lesson,
				adjustment: ann.adjustment,
				wrong_count: 1,
				last_seen: entry.at,
				source_ids: [entry.id],
			});
		}
	}
	meta.compressed_lessons = [...byKey.values()]
		.sort((a, b) => b.last_seen.localeCompare(a.last_seen))
		.slice(0, 80);
	writeMeta(projectRoot, meta);
	return meta.compressed_lessons;
}

export function linkFix(projectRoot, body) {
	const wrongId = String(body.wrong_id ?? "");
	const fixId = String(body.fix_id ?? "");
	const adjustment = String(body.adjustment ?? "");
	if (!wrongId || !fixId) throw new Error("wrong_id and fix_id required");
	annotateEntry(projectRoot, {
		id: wrongId,
		verdict: "superseded",
		resolved: true,
		fixed_by_id: fixId,
		adjustment,
		archived: true,
	});
	annotateEntry(projectRoot, {
		id: fixId,
		verdict: "correct",
		resolved: true,
		supersedes_id: wrongId,
		note: adjustment,
	});
	return { ok: true };
}

export function setPrimaryProject(projectRoot, body) {
	const root = String(body.primaryProjectRoot ?? "");
	if (!root) throw new Error("primaryProjectRoot required");
	const dir = join(projectRoot, ".forgemind");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "primary-project.json"),
		JSON.stringify({ primaryProjectRoot: resolve(root), updatedAt: new Date().toISOString() }, null, 2),
		"utf8",
	);
	return resolveAlignment(projectRoot);
}
