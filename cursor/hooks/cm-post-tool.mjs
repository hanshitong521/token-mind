#!/usr/bin/env node
/**
 * ContextMind postToolUse hook — MCP Output Guard.
 *
 * `postToolUse` is the only hook that can replace what the model sees, and only
 * for MCP tools (`updated_mcp_tool_output`). Register it with matchers of the
 * form `MCP:<tool_name>`; a bare tool name never matches an MCP tool.
 *
 * Everything under budget passes through untouched and the hook emits nothing —
 * rewriting an in-budget payload would cost a round trip and buy nothing.
 */

import { mcpGuard, ready, runtime } from "./cm-lib.mjs";

if (!ready) {
	process.stdout.write("{}\n");
	process.exit(0);
}

const { emit, noop, openRuntime, projectRootOf, readHookInput, sessionIdOf } = runtime;
const { governMcpOutput } = mcpGuard;

const input = await readHookInput();
const toolName = String(input.tool_name ?? input.toolName ?? "");
const toolOutput = input.tool_output ?? input.result ?? input.output;

if (!toolName || toolOutput === undefined || toolOutput === null) noop();

const projectRoot = projectRootOf(input);
const rt = openRuntime(projectRoot);
const sessionId = sessionIdOf(input);
const started = performance.now();

const result = governMcpOutput({
	toolOutput,
	toolName,
	cfg: rt.cfg,
	runGate: (args) => rt.gate({ ...args, sessionId, source: toolName }),
});

if (!result) {
	noop();
}

try {
	rt.telemetry.record({
		surface: "mcp",
		toolName,
		sessionId,
		contentType: result.gated.contentType,
		success: !result.gated.failure,
		rawTokens: result.gated.rawTokens,
		emittedTokens: result.gated.emittedTokens,
		toolEmittedSavings: result.gated.rawTokens - result.gated.emittedTokens,
		handleId: result.gated.handleId,
		handleCreated: result.gated.handleId ? 1 : 0,
		dedupHit: result.gated.dedupHit ? 1 : 0,
		firstLayer: result.gated.method,
		gateLatencyMs: result.gated.engineLatencyMs,
		hookLatencyMs: performance.now() - started,
		note: `profile:${result.profile.name}`,
	});
} catch {
	/* telemetry is never load-bearing */
}

emit({ updated_mcp_tool_output: result.output });
process.exit(0);
