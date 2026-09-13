import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canFastAllowHookInput, canFastAllowPre } from "../lib/runtime/fast-allow-pre.mjs";

describe("fast-allow-pre", () => {
	it("allows project-brain search", () => {
		assert.equal(
			canFastAllowHookInput({
				tool_name: "CallMcpTool",
				tool_input: { server: "project-brain", toolName: "search_project_context" },
			}),
			true,
		);
	});

	it("allows ads-mysql", () => {
		assert.equal(
			canFastAllowHookInput({
				tool_name: "callmcptool",
				arguments: { mcp_server: "ads-mysql", tool_name: "query" },
			}),
			true,
		);
	});

	it("allows context_find", () => {
		assert.equal(
			canFastAllowHookInput({
				tool_name: "callmcptool",
				tool_input: { server: "contextmind", toolName: "context_find" },
			}),
			true,
		);
	});

	it("denies context_orient", () => {
		assert.equal(
			canFastAllowHookInput({
				tool_name: "callmcptool",
				tool_input: { server: "contextmind", toolName: "context_orient" },
			}),
			false,
		);
	});

	it("allows non-java write", () => {
		assert.equal(canFastAllowPre("write", { path: "docs/foo.md" }), true);
	});

	it("denies java write", () => {
		assert.equal(canFastAllowPre("write", { path: "src/Foo.java" }), false);
	});

	it("allows read-only git status shell", () => {
		assert.equal(canFastAllowPre("shell", { command: "git status -sb" }), true);
	});

	it("denies git commit shell", () => {
		assert.equal(canFastAllowPre("shell", { command: "git commit -m x" }), false);
	});
});
