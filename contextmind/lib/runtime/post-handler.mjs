/**
 * Post-tool handler (daemon-side). MCP Output Guard + evidence layer.
 * Hang doc H9: Shell never re-governs stdout; oversized MCP payloads skip govern (fail-open).
 */
import { governMcp } from "../adapters/mcp.mjs";
import { parseShellExitCode } from "../shell-result.mjs";
import { openRuntime, projectRootOf, sessionIdOf } from "../runtime.mjs";
import { MINIMAL_CAP_BYTES } from "./constants.mjs";

/** Soft cap before MCP Output Guard — above this, skip govern (Cursor ingest is already the bottleneck). */
const POST_GOVERN_MAX_BYTES = Math.max(MINIMAL_CAP_BYTES * 4, 128_000);

function approxOutputBytes(toolOutput) {
	if (toolOutput == null) return 0;
	if (typeof toolOutput === "string") return Buffer.byteLength(toolOutput, "utf8");
	if (Buffer.isBuffer(toolOutput)) return toolOutput.length;
	try {
		return Buffer.byteLength(JSON.stringify(toolOutput), "utf8");
	} catch {
		return POST_GOVERN_MAX_BYTES + 1;
	}
}

export async function handlePostTool(input, { openRuntime: openRt = openRuntime } = {}) {
	const toolName = String(input.tool_name ?? input.toolName ?? "");
	const toolOutput = input.tool_output ?? input.result ?? input.output;
	if (!toolName || toolOutput === undefined || toolOutput === null) return {};

	const projectRoot = projectRootOf(input);
	const rt = openRt(projectRoot);
	const sessionId = sessionIdOf(input);
	const name = toolName.toLowerCase();

	if (name === "shell" || name.includes("shell")) {
		try {
			const exitCode = parseShellExitCode(toolOutput);
			rt.telemetry.record({
				surface: "shell",
				toolName: "Shell",
				sessionId,
				success: exitCode === null || exitCode === 0,
				note: exitCode === null ? "shell_audit" : `exit:${exitCode}`,
			});
		} catch {
			/* telemetry never load-bearing */
		}
		return {};
	}

	if (approxOutputBytes(toolOutput) > POST_GOVERN_MAX_BYTES) {
		try {
			rt.telemetry.record({
				surface: "mcp",
				toolName,
				sessionId,
				success: true,
				note: "post_skip_oversized",
			});
		} catch {
			/* ok */
		}
		return {};
	}

	const result = governMcp({
		toolOutput,
		toolName,
		cfg: rt.cfg,
		rt,
		sessionId,
	});

	if (!result) return {};

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
			note: `profile:${result.profile.name}`,
		});
	} catch {
		/* ok */
	}

	return { updated_mcp_tool_output: result.output };
}
