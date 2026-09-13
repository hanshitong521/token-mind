import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../contextmind/lib/runtime/lifecycle.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = join(ROOT, "cursor", "hooks");
const exe = join(HOOKS, "cmhook.exe");

function runCase(label, args, input) {
	const r = spawnSync(exe, args, {
		input: JSON.stringify(input),
		encoding: "utf8",
		windowsHide: true,
		timeout: 8_000,
	});
	assert.equal(r.status, 0, `${label} exit ${r.status} ${r.stderr}`);
	const raw = (r.stdout || "").trim();
	assert.ok(raw.startsWith("{"), `${label} not json: ${JSON.stringify(raw.slice(0, 160))}`);
	JSON.parse(raw);
}

await startDaemon({ waitMs: 6_000 });
assert.ok(existsSync(exe), "build native\\build-cmhook.cmd first");

const base = {
	conversation_id: "verify",
	cwd: ROOT,
	workspace_roots: [ROOT],
};

runCase("shell", ["cm-pre-tool"], {
	...base,
	tool_name: "Shell",
	tool_input: { command: "echo ok" },
});
runCase("git_status", ["cm-pre-tool"], {
	...base,
	tool_name: "Shell",
	tool_input: { command: "git status -sb" },
});
runCase("read", ["cm-pre-tool"], {
	...base,
	tool_name: "Read",
	tool_input: { path: join(HOOKS, "cm-rpc.mjs") },
});
runCase("post", ["cm-post-tool"], {
	...base,
	tool_name: "Shell",
	tool_output: "ok\n",
});

console.log("cmhook JSON ok (shell, git_status, read, post)");
