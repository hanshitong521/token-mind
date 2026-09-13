#!/usr/bin/env node
/** Hook latency matrix: sessionStart, beforeSubmitPrompt, pre, post. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHEJIU = "e:/workA/shejiuPro";
const HOOKS = join(SHEJIU, ".cursor/hooks");

function runNode(script, inputObj) {
	const t0 = performance.now();
	const r = spawnSync(process.execPath, [join(HOOKS, script)], {
		input: JSON.stringify(inputObj),
		encoding: "utf8",
		timeout: 120_000,
		windowsHide: true,
		env: { ...process.env, CONTEXTMIND_HOME: join(SHEJIU, ".cursor/contextmind") },
	});
	return {
		ms: Math.round(performance.now() - t0),
		status: r.status,
		okJson: (() => {
			try {
				JSON.parse((r.stdout || "").trim() || "{}");
				return true;
			} catch {
				return false;
			}
		})(),
		outLen: (r.stdout || "").length,
	};
}

const base = { cwd: SHEJIU, workspace_roots: [SHEJIU], conversation_id: "bench-hooks" };

const rows = [
	["pre Write fast", runNode("cm-pre-tool.mjs", { ...base, tool_name: "Write", tool_input: { path: "docs/x.md" } })],
	["pre Read small", runNode("cm-pre-tool.mjs", { ...base, tool_name: "Read", tool_input: { path: ".cursor/hooks/cm-rpc.mjs", limit: 20 } })],
	["pre git status", runNode("cm-pre-tool.mjs", { ...base, tool_name: "Shell", tool_input: { command: "git status -sb" } })],
	["post Shell small", runNode("cm-post-tool.mjs", { ...base, tool_name: "Shell", tool_output: "ok\n" })],
	[
		"post Shell 80k",
		runNode("cm-post-tool.mjs", {
			...base,
			tool_name: "Shell",
			tool_output: "x".repeat(80_000),
		}),
	],
	["sessionStart", runNode("cm-session-start.mjs", { ...base, session_id: "s1" })],
	[
		"beforeSubmitPrompt",
		runNode("cm-before-submit-prompt.mjs", { ...base, prompt: "fix OceanProductQueryServiceImpl bug" }),
	],
];

for (const [label, r] of rows) {
	console.log(`${label.padEnd(22)} ${String(r.ms).padStart(6)}ms  exit=${r.status}  json=${r.okJson}  out=${r.outLen}`);
}

const slow = rows.filter(([, r]) => r.ms > 3000);
process.exit(slow.length ? 1 : 0);
