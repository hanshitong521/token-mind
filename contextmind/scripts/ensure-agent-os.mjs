#!/usr/bin/env node
/**
 * shejiuPro Agent OS overlay — hooks.json Shell postToolUse + hook/lib overlays.
 * Run after Token-Mind `contextmind install` (which resets hooks).
 *
 *   node .cursor/contextmind/scripts/ensure-agent-os.mjs
 *   node .cursor/contextmind/scripts/ensure-agent-os.mjs --check
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CM = resolve(HERE, "..");
const PROJECT = resolve(CM, "..", "..");
const CURSOR = join(PROJECT, ".cursor");
const HOOKS = join(CURSOR, "hooks");
const OVERLAY = join(CM, "overlays", "shejiu-agent-os");
const HOOKS_JSON = join(CURSOR, "hooks.json");

const POST_MATCHER =
	"Shell|CallMcpTool|MCP:mysql_query|MCP:semantic_search|MCP:get_evidence|MCP:codegraph_explore|MCP:ads-mysql|MCP:context_orient|MCP:context_fetch|MCP:context_find|MCP:context_get|MCP:context_impact|MCP:context_run";

const checkOnly = process.argv.includes("--check");

function copyOverlay(subdir, destDir) {
	const src = join(OVERLAY, subdir);
	if (!existsSync(src)) return [];
	const copied = [];
	for (const name of readdirSync(src)) {
		const from = join(src, name);
		if (!name.endsWith(".mjs")) continue;
		const to = join(destDir, name);
		if (checkOnly) {
			if (!existsSync(to)) copied.push(`MISSING ${to}`);
			continue;
		}
		copyFileSync(from, to);
		copied.push(name);
	}
	return copied;
}

function patchHooksJson() {
	if (!existsSync(HOOKS_JSON)) return { ok: false, detail: "no hooks.json" };
	const data = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));
	const list = data?.hooks?.postToolUse ?? [];
	let hit = false;
	for (const h of list) {
		if (!String(h.command ?? "").includes("cm-post-tool")) continue;
		hit = true;
		if (h.matcher === POST_MATCHER) return { ok: true, detail: "postToolUse already has Shell|" };
		if (checkOnly) return { ok: false, detail: `postToolUse matcher missing Shell: ${h.matcher}` };
		h.matcher = POST_MATCHER;
		writeFileSync(HOOKS_JSON, `${JSON.stringify(data, null, 2)}\n`, "utf8");
		return { ok: true, detail: "patched postToolUse matcher (Shell|…)" };
	}
	return { ok: false, detail: hit ? "cm-post-tool entry odd" : "no cm-post-tool in postToolUse" };
}

function main() {
	const hookFiles = copyOverlay("hooks", HOOKS);
	const libFiles = copyOverlay("lib", join(CM, "lib"));
	const hooks = patchHooksJson();
	const lines = [
		`project: ${PROJECT}`,
		`hooks overlay: ${hookFiles.length ? hookFiles.join(", ") : checkOnly ? "check only" : "none"}`,
		`lib overlay: ${libFiles.length ? libFiles.join(", ") : checkOnly ? "check only" : "none"}`,
		`hooks.json: ${hooks.detail}`,
	];
	if (!hooks.ok) {
		console.error(lines.join("\n"));
		console.error("\nFix: run without --check, then Reload Window in Cursor.");
		process.exit(1);
	}
	console.log(lines.join("\n"));
	if (!checkOnly) {
		console.log("\nReload Window (Ctrl+Shift+P → Developer: Reload Window) so Cursor reloads hooks.json.");
	}
}

main();
