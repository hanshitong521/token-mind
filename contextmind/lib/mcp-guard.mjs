/**
 * MCP Output Guard (spec 17).
 *
 * Wire-up facts, verified against https://cursor.com/docs/hooks on 2026-09-01:
 *
 *   - `postToolUse` is the only hook whose output supports replacing what the
 *     model sees (`updated_mcp_tool_output`), and it is MCP-only.
 *   - Its matcher for MCP tools is `MCP:<tool_name>`, not the bare tool name.
 *     A matcher of `mysql_query` never matches an MCP tool.
 *   - Its input field is `tool_output` — the stringified result payload.
 *   - `afterMCPExecution` carries `result_json` but documents no output fields,
 *     so it can observe and cannot govern.
 *
 * The shejiuPro hook this replaces used matcher `mysql_query|semantic_search|...`
 * and read `mcp_tool_output`, so it was very likely never firing at all; that
 * finding is in docs/evidence/CURSOR_HOOK_CONTRACT.md.
 */

import { countTokens } from "./tokens.mjs";

/**
 * Unwrap a `postToolUse` `tool_output` into the text the model would have seen.
 * Handles the three shapes seen in practice: a JSON string of an MCP content
 * array, a JSON string of a bare string, and plain text.
 */
export function extractText(toolOutput) {
	if (toolOutput === null || toolOutput === undefined) return { text: "", shape: "empty" };
	if (typeof toolOutput !== "string") {
		return { text: typeof toolOutput === "object" ? JSON.stringify(toolOutput) : String(toolOutput), shape: "raw" };
	}

	let parsed = null;
	try {
		parsed = JSON.parse(toolOutput);
	} catch {
		return { text: toolOutput, shape: "text" };
	}

	if (Array.isArray(parsed)) {
		const texts = parsed
			.map((c) => (c && typeof c === "object" && typeof c.text === "string" ? c.text : null))
			.filter((t) => t !== null);
		if (texts.length === parsed.length && texts.length > 0) return { text: texts.join("\n"), shape: "mcp_content" };
		return { text: toolOutput, shape: "json_array" };
	}
	if (parsed && typeof parsed === "object" && Array.isArray(parsed.content)) {
		const texts = parsed.content
			.map((c) => (c && typeof c === "object" && typeof c.text === "string" ? c.text : null))
			.filter((t) => t !== null);
		if (texts.length > 0) return { text: texts.join("\n"), shape: "mcp_result" };
		return { text: toolOutput, shape: "json_object" };
	}
	if (typeof parsed === "string") return { text: parsed, shape: "json_string" };
	return { text: toolOutput, shape: "json" };
}

/** Re-wrap governed text in the shape the input arrived in. */
export function rewrap(text, shape, original) {
	if (shape === "mcp_content") {
		try {
			const parsed = JSON.parse(original);
			const first = parsed[0] ?? {};
			return [{ ...first, type: first.type ?? "text", text }];
		} catch {
			return [{ type: "text", text }];
		}
	}
	if (shape === "mcp_result") {
		try {
			const parsed = JSON.parse(original);
			return { ...parsed, content: [{ type: "text", text }] };
		} catch {
			return { content: [{ type: "text", text }] };
		}
	}
	return text;
}

/** Resolve the per-tool profile, falling back to the safe generic one. */
export function profileFor(cfg, toolName) {
	const profiles = cfg.mcp_guard.profiles ?? {};
	const key = String(toolName ?? "");
	if (profiles[key]) return { ...profiles[key], name: key };
	const lower = key.toLowerCase();
	for (const [name, profile] of Object.entries(profiles)) {
		if (lower.includes(name.toLowerCase())) return { ...profile, name };
	}
	return { name: "generic", max_tokens: cfg.budget.mcp_default, preserve: ["type", "top_level_keys"], body: "handle" };
}

/**
 * Decide whether a tool is governed at all.
 *
 * CodeGraph explore is deliberately excluded: the source it returns IS the edit
 * surface, and clipping it mid-method would trade tokens for correctness. It is
 * instead recorded as read-for-dedup (spec 14: explore returning source counts
 * as a Read).
 */
export function isGoverned(toolName) {
	const n = String(toolName ?? "").toLowerCase();
	if (n.includes("codegraph") || n.includes("explore")) return false;
	return true;
}

/**
 * Run the guard over one MCP result.
 *
 * Returns null when nothing should change — emitting an unchanged payload
 * through `updated_mcp_tool_output` would only add a round trip.
 */
export function governMcpOutput({ toolOutput, toolName, cfg, runGate }) {
	if (!cfg.mcp_guard.enabled) return null;
	if (!isGoverned(toolName)) return null;

	const { text, shape } = extractText(toolOutput);
	if (text.trim().length === 0) return null;

	const profile = profileFor(cfg, toolName);
	const rawTokens = countTokens(text);
	if (rawTokens <= profile.max_tokens) return null;

	// The profile owns the size the gate packs against. Letting the gate fall back
	// to budget.mcp_default silently widens the budget for every profile narrower
	// than it — a payload between the two sizes is "over its profile" here and
	// "already inside budget" in the gate, so it comes back untouched.
	const gated = runGate({
		raw: text,
		toolName,
		surface: "mcp",
		cmd: null,
		budgetTokens: profile.max_tokens,
	});
	if (!gated || gated.emittedTokens >= rawTokens) return null;

	return {
		output: rewrap(gated.text, shape, typeof toolOutput === "string" ? toolOutput : String(toolOutput)),
		gated,
		profile,
		shape,
	};
}
