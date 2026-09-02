/**
 * S4 six-tool MCP layer (spec 9, decision 5C, ADR-0004).
 *
 * Covers the three contracts that matter:
 *  - the schema tax: tools/list must fit budget.mcp_schema_total tokens;
 *  - the dispatch: every tool's degrade path returns status semantics, never
 *    a fake success (decision 5C: a missing API must not pretend to have run);
 *  - the wire: mcp-server.mjs as a real subprocess answers the JSON-RPC
 *    handshake, lists tools and dispatches a call (L4 contract).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { countTokens } from "../lib/tokens.mjs";
import { loadConfigFrom } from "../lib/config.mjs";
import { openRuntime } from "../lib/runtime.mjs";
import { toolSpecs, callTool } from "../lib/mcp-tools.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NO_USER = join(tmpdir(), "contextmind-no-user-config.json");
const SERVER = join(HERE, "..", "mcp-server.mjs");

let dir;
let rt;

before(() => {
	dir = mkdtempSync(join(tmpdir(), "cm-mcp-"));
	const cfg = loadConfigFrom(NO_USER, dir);
	rt = openRuntime(dir);
	// Point the codegraph adapter at a binary that does not exist so the
	// degrade paths are deterministic regardless of what's installed.
	rt.cfg = { ...rt.cfg, adapters: { ...rt.cfg.adapters, codegraph: { ...rt.cfg.adapters.codegraph, bin: "cm-no-such-codegraph" } } };
});

after(() => {
	rt.close();
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* temp dir */
	}
});

describe("schema budget", () => {
	it("exposes exactly the six spec-9 tools", () => {
		assert.deepEqual(
			toolSpecs().map((t) => t.name),
			["context_orient", "context_find", "context_get", "context_impact", "context_run", "context_fetch"],
		);
	});

	it("tools/list payload fits budget.mcp_schema_total (2500 tokens)", () => {
		const payload = JSON.stringify({ tools: toolSpecs() });
		const tokens = countTokens(payload);
		assert.ok(tokens <= rt.cfg.budget.mcp_schema_total, `schema is ${tokens} tokens, cap ${rt.cfg.budget.mcp_schema_total}`);
	});
});

describe("degrade semantics (no codegraph installed)", () => {
	it("context_orient reports ADAPTER_MISSING, never a fake result", async () => {
		const res = await callTool("context_orient", { query: "OrderServiceImpl" }, rt);
		const text = res.content[0].text;
		assert.match(text, /status=ADAPTER_MISSING/);
		assert.ok(countTokens(text) <= 120, "degrade message must stay in the warning budget");
	});

	it("context_find reports ADAPTER_MISSING", async () => {
		const res = await callTool("context_find", { symbol: "Bar" }, rt);
		assert.match(res.content[0].text, /status=ADAPTER_MISSING/);
	});

	it("context_impact reports ADAPTER_MISSING", async () => {
		const res = await callTool("context_impact", { symbol: "Bar" }, rt);
		assert.match(res.content[0].text, /status=ADAPTER_MISSING/);
	});
});

describe("context_get", () => {
	it("packs anchored files with provenance and an omitted count", async () => {
		writeFileSync(join(dir, "Svc.java"), "class Svc {\n  void a() {}\n}\n".repeat(10));
		const res = await callTool(
			"context_get",
			{ task: "edit Svc", anchors: ["Svc.java"], budget_tokens: 200 },
			rt,
		);
		const text = res.content[0].text;
		assert.match(text, /### Svc\.java \(lines 1-\d+ of \d+, mtime /);
		assert.match(text, /budget=200 tok/);
	});

	it("returns NO_CANDIDATES with next-step guidance when nothing qualifies", async () => {
		const res = await callTool("context_get", { task: "anything" }, rt);
		assert.match(res.content[0].text, /status=NO_CANDIDATES/);
	});

	it("rejects anchors that escape the project root", async () => {
		const res = await callTool("context_get", { task: "x", anchors: ["../../etc/passwd"] }, rt);
		assert.equal(res.isError, true);
		assert.match(res.content[0].text, /escapes project root/);
	});
});

describe("context_run", () => {
	it("governs a successful command: exit code and output present, telemetry row written", async () => {
		const res = await callTool("context_run", { command: "echo hello-s4" }, rt);
		const text = res.content[0].text;
		assert.match(text, /exit_code=0/);
		assert.match(text, /hello-s4/);
	});

	it("keeps failure evidence: non-zero exit and stderr survive", async () => {
		const res = await callTool("context_run", { command: "node -e \"process.stderr.write('boom-trace'); process.exit(3)\"" }, rt);
		const text = res.content[0].text;
		assert.match(text, /exit_code=3/);
		assert.match(text, /boom-trace/);
	});
});

describe("context_fetch", () => {
	it("round-trips a handle byte-for-byte", async () => {
		const handleId = rt.handles.put("line one\nline two\nline three\n", { sourceType: "test" });
		assert.ok(handleId);
		const res = await callTool("context_fetch", { handle: handleId }, rt);
		assert.equal(res.content[0].text, "line one\nline two\nline three\n");
	});

	it("applies a line selector", async () => {
		const handleId = rt.handles.put("a\nb\nc\n", { sourceType: "test" });
		const res = await callTool("context_fetch", { handle: handleId, selector: { start: 2, end: 3 } }, rt);
		assert.equal(res.content[0].text, "b\nc");
	});

	it("unknown handle is an MCP error, not an empty success", async () => {
		const res = await callTool("context_fetch", { handle: "h_nope" }, rt);
		assert.equal(res.isError, true);
		assert.match(res.content[0].text, /unknown or expired handle/);
	});
});

describe("wire protocol (L4 contract, real subprocess)", () => {
	function rpc(lines) {
		const res = spawnSync(process.execPath, [SERVER], {
			input: lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, CONTEXTMIND_PROJECT_DIR: dir },
		});
		assert.equal(res.status, 0, `server exited ${res.status}: ${res.stderr}`);
		const frames = res.stdout
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
		return frames;
	}

	it("handshake -> tools/list -> tools/call over stdio", () => {
		const frames = rpc([
			{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ jsonrpc: "2.0", id: 2, method: "tools/list" },
			{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "context_run", arguments: { command: "echo wire-ok" } } },
			{ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
		]);
		assert.equal(frames.length, 4); // notifications get no response

		const init = frames.find((f) => f.id === 1);
		assert.equal(init.result.serverInfo.name, "contextmind");
		assert.equal(init.result.protocolVersion, "2025-06-18");
		assert.ok(init.result.capabilities.tools);

		const list = frames.find((f) => f.id === 2);
		assert.equal(list.result.tools.length, 6);

		const call = frames.find((f) => f.id === 3);
		assert.equal(call.result.content[0].type, "text");
		assert.match(call.result.content[0].text, /wire-ok/);

		const bad = frames.find((f) => f.id === 4);
		assert.equal(bad.result.isError, true);
		assert.match(bad.result.content[0].text, /unknown tool/);
	});
});
