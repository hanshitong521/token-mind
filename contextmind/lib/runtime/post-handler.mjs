/**
 * Post-tool handler (daemon-side).
 *
 * AI-NOTE (H9):
 * - DO NOT: re-govern Shell stdout here (already captured/wrap'd). Second pass hung sessions.
 * - DO NOT: govern MCP payloads >~128KB — skip fail-open (Cursor ingest is the bottleneck).
 * - AFTER CHANGE TEST: large Shell output returns quickly; MCP >128KB shows post_skip_oversized
 *   in telemetry; no multi-second postTool stalls on `git status`/`dir`.
 * Evidence: docs/agent-stack/AGENT-SESSION-HANG-2026-09-11.md §H9
 */
import { governMcp } from "../adapters/mcp.mjs";
import { parseShellExitCode } from "../shell-result.mjs";
import { detectAgent, detectHost } from "../hosts.mjs";
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

/**
 * Every spelling of "the host is calling an MCP tool".
 *
 * Cursor invokes MCP tools directly (`CallMcpTool`, tool name often `MCP:<name>`); Qoder
 * routes them through the meta-tools `mcp_call` / `mcp_get` / `mcp_list` and puts the real
 * target in `tool_input.toolName` as `mcp__<server>__<tool>`; Trae uses the single `run_mcp`
 * meta-tool with `tool_input.server_name` + `tool_input.tool_name`.
 *
 * Without this the profile lookup sees only `mcp_call` and every Qoder MCP result falls back
 * to the generic profile, so `search_project_context` loses its 450-token budget and the
 * codegraph opt-out below never fires. Same normalisation as pre-handler.mjs MCP_CALL_TOOLS.
 */
const MCP_CALL_TOOLS = new Set(["callmcptool", "mcp_call", "mcp_get", "mcp_list", "run_mcp"]);

export function governToolName(toolName, input) {
	const raw = String(toolName ?? "");
	if (raw.toLowerCase().startsWith("mcp:")) return raw.slice(4);
	if (!MCP_CALL_TOOLS.has(raw.toLowerCase())) return raw;
	const args = input?.tool_input ?? input?.arguments ?? {};
	const inner = args?.toolName ?? args?.tool_name ?? args?.name;
	if (inner) return String(inner);
	// Trae's `run_mcp` spells the target as two keys rather than one `mcp__…` string.
	if (args?.server_name && args?.tool_name) return `mcp__${args.server_name}__${args.tool_name}`;
	return raw;
}

export async function handlePostTool(input, { openRuntime: openRt = openRuntime } = {}) {
	const toolName = String(input.tool_name ?? input.toolName ?? "");
	// `tool_response` is Qoder's name for the same thing Cursor sends as `tool_output`.
	const toolOutput = input.tool_output ?? input.tool_response ?? input.result ?? input.output;
	if (!toolName || toolOutput === undefined || toolOutput === null) return {};

	const projectRoot = projectRootOf(input);
	const rt = openRt(projectRoot);
	const sessionId = sessionIdOf(input);
	// Derived once for the whole payload; every record below tags the row with it.
	const host = detectHost(input);
	const agent = detectAgent(input);
	const name = toolName.toLowerCase();
	// The tool that actually ran: `mcp_call` on Qoder unwraps to `mcp__<server>__<tool>`.
	const governed = governToolName(toolName, input);

	if (name === "shell" || name.includes("shell") || name === "bash") {
		try {
			const exitCode = parseShellExitCode(toolOutput);
			rt.telemetry.record({
				surface: "shell",
				// Record the host's real name: Cursor says Shell, Qoder says Bash.
				toolName,
				sessionId,
				host,
				agent,
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
				// Inner tool when the host routed through a meta-tool, matching pre-handler.
				toolName: governed,
				sessionId,
				host,
				agent,
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
		toolName: governed,
		cfg: rt.cfg,
		rt,
		sessionId,
	});

	if (!result) return {};

	try {
		rt.telemetry.record({
			surface: "mcp",
			toolName: governed,
			sessionId,
			host,
			agent,
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
