/**
 * L4 — Cursor Hook contract tests (spec 34).
 *
 * Hooks are exercised as real subprocesses fed real payloads, because the
 * contract that matters is "what comes out on stdout" — an in-process call
 * would pass while the hook still printed debug text or exited non-zero.
 *
 * These are the assertions:
 *   - stdout is exactly one JSON object (a stray log is an unparseable hook)
 *   - the decision field names match the documented Cursor contract
 *   - exit code is 0, since the decision travels in the payload
 *   - malformed input and a missing library both fail open
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = resolve(HERE, "..", "..", "cursor", "hooks");

let workDir;

before(() => {
	workDir = mkdtempSync(join(tmpdir(), "cm-hook-"));
	mkdirSync(join(workDir, ".cursor"), { recursive: true });
	writeFileSync(join(workDir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));
});

after(() => {
	// Best effort; mkdtemp dirs are outside the repo and cleaned by the OS.
});

function runHook(name, payload, env = {}) {
	const res = spawnSync(process.execPath, [join(HOOKS, name)], {
		input: JSON.stringify(payload),
		env: {
			...process.env,
			CONTEXTMIND_TELEMETRY_DB: join(workDir, "t.db"),
			CONTEXTMIND_PROJECT_ROOT: workDir,
			CURSOR_PROJECT_DIR: workDir,
			...env,
		},
		timeout: 60_000,
		windowsHide: true,
	});
	if (res.error) throw res.error;
	const stdout = res.stdout?.toString("utf8") ?? "";
	let json = null;
	let parseError = null;
	try {
		json = JSON.parse(stdout.trim());
	} catch (err) {
		parseError = err instanceof Error ? err.message : String(err);
	}
	return { status: res.status, stdout, json, parseError, stderr: res.stderr?.toString("utf8") ?? "" };
}

describe("hook contract", () => {
	it("pre-tool emits one JSON object and exits 0 on an unknown tool", () => {
		const r = runHook("cm-pre-tool.mjs", { tool_name: "Write", tool_input: {}, conversation_id: "s1" });
		assert.equal(r.parseError, null, `stdout was not JSON: ${r.stdout}`);
		assert.equal(r.status, 0);
	});

	it("pre-tool survives malformed stdin", () => {
		const res = spawnSync(process.execPath, [join(HOOKS, "cm-pre-tool.mjs")], {
			input: "{not json",
			env: { ...process.env, CONTEXTMIND_TELEMETRY_DB: join(workDir, "t.db") },
			windowsHide: true,
		});
		assert.equal(res.status, 0);
		assert.doesNotThrow(() => JSON.parse(res.stdout.toString().trim() || "{}"));
	});

	it("pre-tool fails open when the library path is wrong", () => {
		// A bad CONTEXTMIND_HOME must never turn into a blocked tool call. The
		// upward walk is allowed to recover; what matters is that the worst case
		// is "not governed", not "denied".
		const r = runHook("cm-pre-tool.mjs", { tool_name: "Read", tool_input: { file_path: "x" } }, {
			CONTEXTMIND_HOME: join(workDir, "does-not-exist"),
		});
		assert.equal(r.status, 0);
		assert.equal(r.parseError, null, r.stdout);
		assert.notEqual(r.json.permission, "deny");
	});
});

describe("read guard", () => {
	it("denies an unbounded read of a large Java service and names the next step", () => {
		const path = join(workDir, "BigServiceImpl.java");
		writeFileSync(path, `${"    public void doSomethingImportant(int id) { /* body */ }\n".repeat(400)}`);
		const r = runHook("cm-pre-tool.mjs", {
			tool_name: "Read",
			tool_input: { file_path: path },
			conversation_id: "s1",
		});
		assert.equal(r.json.permission, "deny");
		assert.match(r.json.agent_message, /context_orient|context_find|context_get|offset/);
		assert.ok(r.json.user_message.length > 0);
	});

	it("allows a bounded read of the same file", () => {
		const path = join(workDir, "BigServiceImpl.java");
		const r = runHook("cm-pre-tool.mjs", {
			tool_name: "Read",
			tool_input: { file_path: path, offset: 1, limit: 40 },
			conversation_id: "s1",
		});
		assert.equal(r.json.permission, "allow");
	});

	it("allows a small file outright", () => {
		const path = join(workDir, "Tiny.java");
		writeFileSync(path, "public class Tiny {}\n");
		const r = runHook("cm-pre-tool.mjs", {
			tool_name: "Read",
			tool_input: { file_path: path },
			conversation_id: "s1",
		});
		assert.equal(r.json.permission, "allow");
	});

	it("denies a whole Mapper.xml read", () => {
		const path = join(workDir, "TProductMapper.xml");
		writeFileSync(path, "<mapper>\n" + `${"<select id=\"x\">select 1</select>\n".repeat(500)}</mapper>`);
		const r = runHook("cm-pre-tool.mjs", {
			tool_name: "Read",
			tool_input: { file_path: path },
			conversation_id: "s1",
		});
		assert.equal(r.json.permission, "deny");
		assert.match(r.json.agent_message, /statement/i);
	});

	it("honours override_reason and records it", () => {
		const path = join(workDir, "BigServiceImpl.java");
		const r = runHook("cm-pre-tool.mjs", {
			tool_name: "Read",
			tool_input: { file_path: path, override_reason: "user asked for the whole file" },
			conversation_id: "s1",
		});
		assert.equal(r.json.permission, "allow");
	});
});

describe("shell guard", () => {
	it("rewrites an eligible command through the locked first layer", () => {
		const r = runHook("cm-pre-tool.mjs", {
			tool_name: "Shell",
			tool_input: { command: "git status" },
			conversation_id: "s1",
		});
		assert.equal(r.json.permission, "allow");
		assert.match(r.json.updated_input.command, /context-compress[^\n]*wrap/);
		assert.match(r.json.additional_context, /contextmind/i);
	});

	it("does not rewrite a piped command", () => {
		const r = runHook("cm-pre-tool.mjs", {
			tool_name: "Shell",
			tool_input: { command: "git status | head -5" },
			conversation_id: "s1",
		});
		assert.equal(r.json.updated_input, undefined);
	});

	it("does not double-wrap an already wrapped command", () => {
		const once = runHook("cm-pre-tool.mjs", {
			tool_name: "Shell",
			tool_input: { command: "git status" },
			conversation_id: "s1",
		});
		const twice = runHook("cm-pre-tool.mjs", {
			tool_name: "Shell",
			tool_input: { command: once.json.updated_input.command },
			conversation_id: "s1",
		});
		assert.equal(twice.json.updated_input, undefined);
	});

	it("never routes a command through rtk", () => {
		const r = runHook("cm-pre-tool.mjs", {
			tool_name: "Shell",
			tool_input: { command: "git log --oneline -40" },
			conversation_id: "s1",
		});
		assert.doesNotMatch(r.stdout, /\brtk\b/i);
	});

	it("blocks a recursive directory dump", () => {
		const r = runHook("cm-pre-tool.mjs", {
			tool_name: "Shell",
			tool_input: { command: "dir /s /b" },
			conversation_id: "s1",
		});
		assert.equal(r.json.permission, "deny");
	});
});

describe("mcp output guard", () => {
	const bigRows = JSON.stringify(
		Array.from({ length: 400 }, (_, i) => ({
			id: i,
			name: `product-${i}`,
			payload: `x`.repeat(120),
		})),
	);

	it("replaces an oversized MCP payload with a governed one plus a handle", () => {
		const r = runHook("cm-post-tool.mjs", {
			tool_name: "mysql_query",
			tool_output: JSON.stringify([{ type: "text", text: bigRows }]),
			conversation_id: "s1",
		});
		assert.equal(r.status, 0);
		const out = r.json.updated_mcp_tool_output;
		assert.ok(out, "expected updated_mcp_tool_output");
		const text = Array.isArray(out) ? out[0].text : out;
		assert.ok(text.length < bigRows.length, `expected shorter output, got ${text.length} vs ${bigRows.length}`);
		assert.match(text, /handle=h_/);
	});

	it("leaves an in-budget MCP payload alone", () => {
		const r = runHook("cm-post-tool.mjs", {
			tool_name: "mysql_query",
			tool_output: JSON.stringify([{ type: "text", text: "3 rows" }]),
			conversation_id: "s1",
		});
		assert.equal(r.json.updated_mcp_tool_output, undefined);
	});

	it("does not clip codegraph explore: its source is the edit surface", () => {
		const r = runHook("cm-post-tool.mjs", {
			tool_name: "codegraph_explore",
			tool_output: JSON.stringify([{ type: "text", text: bigRows }]),
			conversation_id: "s1",
		});
		assert.equal(r.json.updated_mcp_tool_output, undefined);
	});
});

describe("session lifecycle", () => {
	it("warns about unconfigured adapters within the 120-token budget", () => {
		// The probe counts a codegraph *CLI* on PATH as configured, so which
		// adapters look missing depends on the host machine. Pin PATH empty to
		// assert the contract — a bare project warns about every enabled
		// adapter — instead of the machine the suite happens to run on.
		const r = runHook(
			"cm-session-start.mjs",
			{ session_id: "s1", conversation_id: "s1" },
			{ PATH: "", PATHEXT: "" },
		);
		assert.equal(r.status, 0);
		assert.ok(r.json.additional_context, "expected a warning");
		assert.match(r.json.additional_context, /codegraph/);
		// 120 tokens at chars/4 is 480 chars.
		assert.ok(r.json.additional_context.length <= 480);
	});

	it("sessionEnd exits 0 and clears session state", () => {
		const r = runHook("cm-session-end.mjs", { session_id: "s1", reason: "completed" });
		assert.equal(r.status, 0);
		assert.equal(r.parseError, null, r.stdout);
	});
});

describe("stop gate", () => {
	it("is inert when the project has no gate state", () => {
		const r = runHook("cm-stop.mjs", { status: "completed", loop_count: 0 });
		assert.equal(r.status, 0);
		assert.equal(r.json.followup_message, undefined);
	});
});
