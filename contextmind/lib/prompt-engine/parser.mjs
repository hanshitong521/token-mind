/**
 * Prompt Parser — deterministic input → PromptManifest.
 *
 * Prompt Lab spec §8: parser does deterministic parsing + heuristic
 * structure recognition (no LLM in phase-1 core). The same input must
 * always produce the same blocks and stable IDs, so analyzers can diff
 * snapshots across sessions without a provider in the loop.
 *
 * Supported entry types (spec §6):
 *  - raw markdown prompt / system prompt
 *  - OpenAI-style { messages: [...] } or bare messages array
 *  - Anthropic-style { system, messages, tools }
 *  - MCP tools/list { tools: [...] }
 *  - AGENTS.md / CLAUDE.md / SKILL.md / Cursor rules (markdown family,
 *    detected by sourceType)
 */

import { createBlock, createManifest, sha256 } from "./manifest.mjs";
import { stabilityFromContent } from "./volatility.mjs";
import { detectSecrets } from "./secrets.mjs";

// ─── block kind heuristics ───

const RULE_SECTION_RE =
	/^(#{1,6}\s*)?(rules?|core rules?|instructions?|guidelines?|constraints?|principles?)\b/im;
const TOOL_SECTION_RE =
	/^(#{1,6}\s*)?(tools?|mcp tools?|tool schemas?|functions?)\b/im;
const EXAMPLE_SECTION_RE =
	/^(#{1,6}\s*)?(examples?|example outputs?|sample)\b/im;
const PROJECT_SECTION_RE =
	/^(#{1,6}\s*)?(project|architecture|stack|repo(?:sitory)? map)\b/im;
const USER_SECTION_RE = /^(#{1,6}\s*)?(user (?:request|prompt|task))\b/im;

function detectLanguage(text) {
	if (/\bfrom\s+[\w].*import\b|\bimport\s+.*\bfrom\b|\bdef\s+\w+\s*\(/m.test(text)) return "python";
	if (/\bimport\s+[\w{].*from\b|\bexport\s+(?:default\s+)?(?:function|const|class)\b|\brequire\s*\(/m.test(text)) return "js";
	if (/\b(?:public|private|protected)\s+(?:static\s+)?[\w<>,\s]+\s+\w+\s*\(/m.test(text)) return "java";
	if (/\bSELECT\b.*\bFROM\b|\bINSERT\s+INTO\b|\bCREATE\s+TABLE\b/im.test(text)) return "sql";
	if (/^\s*(\/|<!--)/m.test(text)) return "xml";
	if (/^\s*(json){0}/m.test(text)) return "json";
	return "";
}

/**
 * Split markdown into blocks on headings, keeping fenced code intact and
 * never splitting inside a code fence. Deterministic: line order is the
 * only drive.
 */
export function splitMarkdownBlocks(text) {
	const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
	const blocks = [];
	let cur = null;
	let fence = null; // closing fence marker when inside a code block
	let fenceLang = "";

	const flush = () => {
		if (cur) {
			const body = cur.lines.join("\n").trim();
			if (body) blocks.push({ heading: cur.heading, text: body });
			cur = null;
		}
	};

	for (const line of lines) {
		if (fence !== null) {
			if (line.trim().startsWith(fence)) fence = null;
			cur.lines.push(line);
			continue;
		}
		const fenceMatch = line.match(/^\s*(```+|~~~+)\s*([\w.-]*)/);
		if (fenceMatch) {
			flush();
			fence = fenceMatch[1];
			fenceLang = fenceMatch[2] || "";
			cur = { heading: "", lines: [line] };
			continue;
		}
		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			flush();
			cur = { heading: heading[2].trim(), lines: [line] };
			continue;
		}
		if (!cur) cur = { heading: "", lines: [] };
		cur.lines.push(line);
	}
	flush();
	return blocks;
}

function headingKind(heading) {
	const h = heading ?? "";
	if (TOOL_SECTION_RE.test(h)) return "tool_schema";
	if (EXAMPLE_SECTION_RE.test(h)) return "example";
	if (PROJECT_SECTION_RE.test(h)) return "project_contract";
	if (RULE_SECTION_RE.test(h)) return "rule";
	if (USER_SECTION_RE.test(h)) return "user_request";
	return "instruction";
}

/**
 * Try to detect fenced JSON/YAML payload inside a block; returns
 * parsed object or null. Used for tool schemas / structured config.
 */
export function decodeFencedPayload(text) {
	const fence = text.match(/```(?:json|yaml|yml)\s*\n([\s\S]*?)```/);
	if (!fence) {
		const bare = text.trim();
		if (bare.startsWith("{") && bare.endsWith("}")) {
			try {
				return JSON.parse(bare);
			} catch {
				return null;
			}
		}
		return null;
	}
	try {
		if (/^```(yaml|yml)/.test(text)) {
			const lines = fence[1].split("\n").filter((l) => !/^\s*(#.*)?$/.test(l) || l.trim() === "");
			const obj = {};
			for (const l of lines) {
				const m = l.match(/^(\s*)([\w.-]+)\s*:\s*(.+)$/);
				if (m) obj[m[2]] = m[3].replace(/^["']|["']$/g, "").trim();
			}
			return obj;
		}
		return JSON.parse(fence[1]);
	} catch {
		return null;
	}
}

function looksLikeToolSchema(parsed) {
	if (!parsed || typeof parsed !== "object") return false;
	if (Array.isArray(parsed.tools) || Array.isArray(parsed.functions)) return true;
	// Provider-specific schema keys: OpenAI `parameters`, Anthropic
	// `input_schema`, and the camelCase `inputSchema` used by several MCP
	// servers. Missing the last one made inline MCP schemas invisible.
	if (parsed.name && (parsed.parameters || parsed.input_schema || parsed.inputSchema)) return true;
	return false;
}

function roleForKind(kind) {
	if (kind === "user_request") return "user";
	if (kind === "tool_result" || kind === "history") return "assistant";
	return "system";
}

function stabilityForKind(kind) {
	if (kind === "rule" || kind === "instruction") return "STATIC";
	if (kind === "project_contract" || kind === "repo_map" || kind === "tool_schema") {
		return "MOSTLY_STATIC";
	}
	if (kind === "user_request") return "DYNAMIC";
	if (kind === "tool_result" || kind === "history") return "EPHEMERAL";
	return "DYNAMIC";
}

/**
 * Effective stability §10. The kind table is only a claim; the text is the
 * evidence. Volatile spans demote STATIC → DYNAMIC/EPHEMERAL, so a rule block
 * carrying a live timestamp can never be reported as STATIC (round-1 gate #6).
 */
function stabilityFor(kind, text) {
	return stabilityFromContent(text, stabilityForKind(kind));
}

/**
 * DO_NOT_TOUCH content classes (spec §15). These are content-level, not
 * kind-level: a rule block that embeds a SQL statement or a unified diff is
 * untouchable regardless of its kind.
 */
const UNTOUCHABLE_CONTENT = Object.freeze([
	{ re: /\b(?:SELECT\s+[\s\S]{0,80}?\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i, label: "sql" },
	{ re: /(?:^|\n)@@[ \-\d,+]+@@|^[-+]{3}\s+\S+\s/m, label: "code_diff" },
	{ re: /"\s*(?:\$schema|type)\s*"\s*:[^]{0,200}?"properties"\s*:/i, label: "json_schema" },
	{ re: /(?:accept(?:ance)?\s+criteria|definition\s+of\s+done|done\s+when|验收标准|完成标准)/i, label: "acceptance_criteria" },
	{ re: /(?:rm\s+-rf|sudo\s|force[_-]?push|--force|DROP\s+(?:TABLE|DATABASE)|truncate\s+table|生产环境|危险操作)/i, label: "dangerous_operation" },
	{ re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: "private_key" },
]);

/** Which §15 classes make this specific block untouchable (labels, for evidence). */
export function untouchableLabels(text) {
	const labels = [];
	for (const { re, label } of UNTOUCHABLE_CONTENT) {
		if (re.test(String(text ?? ""))) labels.push(label);
	}
	if (detectSecrets(text).length > 0) labels.push("secret");
	return labels;
}

/**
 * Mutability §7/§15. Conservative by construction: anything we cannot prove
 * safe to compact or reorder stays DO_NOT_TOUCH. Erring toward DO_NOT_TOUCH
 * costs a missed optimization; erring the other way destroys correctness.
 */
function mutabilityFor(kind, text, stability) {
	if (untouchableLabels(text).length > 0) return "DO_NOT_TOUCH";
	// Per-run content is never safe to compact or rewrite in place. Moving it
	// is a layout operation (MOVE_BLOCK / EXTRACT_DYNAMIC_BLOCK), which the
	// patch model handles separately from in-place mutation.
	if (stability === "DYNAMIC" || stability === "EPHEMERAL") return "DO_NOT_TOUCH";
	switch (kind) {
		case "user_request":
		case "code":
		case "diff":
		case "tool_schema": // §15 lists JSON Schema as DO_NOT_TOUCH
		case "tool_result":
		case "history":
			return "DO_NOT_TOUCH";
		case "rule":
		case "instruction":
		case "example":
			return "SAFE_COMPACT";
		case "project_contract":
		case "repo_map":
		case "wiki":
			return "SAFE_REORDER";
		default:
			return "DO_NOT_TOUCH";
	}
}

function priorityFor(kind) {
	if (kind === "user_request") return "P0";
	if (kind === "rule") return "P1";
	if (kind === "tool_schema" || kind === "project_contract" || kind === "repo_map" || kind === "wiki") return "P2";
	if (kind === "example") return "P2";
	return "P3";
}

/** Build a PromptBlock[] from raw markdown with kind heuristics. */
export function parseMarkdown(text, { defaultRole = "system", origin = {} } = {}) {
	const blocks = [];
	for (const { heading, text: body } of splitMarkdownBlocks(text)) {
		let kind = headingKind(heading);
		let bodyText = body;
		if (kind === "instruction" && RULE_SECTION_RE.test(bodyText)) kind = "rule";
		const parsed = decodeFencedPayload(bodyText);
		if (parsed && looksLikeToolSchema(parsed)) {
			kind = "tool_schema";
			bodyText = JSON.stringify(parsed);
		}
		const lang = detectLanguage(bodyText);
		if (kind === "instruction" && lang && lang !== "json") kind = "code";
		blocks.push(
			createBlock({
				role: roleForKind(kind),
				kind,
				text: bodyText,
				stability: stabilityFor(kind, bodyText),
				mutability: mutabilityFor(kind, bodyText, stabilityFor(kind, bodyText)),
				priority: priorityFor(kind),
				provenance: origin,
			}),
		);
	}
	return blocks;
}

function normalizeRole(role) {
	const r = String(role ?? "").toLowerCase();
	if (r === "developer" || r === "system") return "system";
	if (r === "tool") return "tool";
	if (r === "assistant") return "assistant";
	return "user";
}

function roleToKind(role) {
	switch (role) {
		case "tool":
			return "tool_result";
		case "assistant":
			return "history";
		default:
			return "instruction";
	}
}

function parseMessages(messages, origin) {
	const blocks = [];
	for (const [i, msg] of (messages ?? []).entries()) {
		if (!msg || typeof msg !== "object") continue;
		let content = msg.content;
		if (Array.isArray(content)) {
			content = content
				.map((part) => {
					if (typeof part === "string") return part;
					if (part?.type === "text") return part.text;
					if (part?.type === "tool_use") {
						return `tool_use: ${part.name ?? ""} ${JSON.stringify(part.input ?? {})}`;
					}
					if (part?.type === "tool_result") {
						const c = Array.isArray(part.content) ? part.content.map((x) => x.text ?? x.content ?? "").join("\n") : part.content ?? "";
						return `tool_result: ${c}`;
					}
					if (part?.type === "image_url" || part?.type === "image") return "[image]";
					return part?.text ?? JSON.stringify(part);
				})
				.filter((s) => s !== undefined)
				.join("\n");
		}
		content = String(content ?? "").trim();
		if (!content) continue;
		const role = normalizeRole(msg.role);
		const kind = role === "user" ? "user_request" : roleToKind(role);
		blocks.push(
			createBlock({
				role,
				kind,
				text: content,
				stability: stabilityFor(kind, content),
				mutability: mutabilityFor(kind, content, stabilityFor(kind, content)),
				priority: priorityFor(kind),
				provenance: { ...origin, section: `messages[${i}]` },
			}),
		);
	}
	return blocks;
}

function parseTools(tools, origin) {
	const blocks = [];
	const norm = [];
	for (const [i, tool] of (tools ?? []).entries()) {
		if (!tool || typeof tool !== "object") continue;
		const schema = tool.input_schema ?? tool.inputSchema ?? tool.parameters ?? tool;
		const entry = { name: tool.name ?? tool.function?.name ?? `tool_${i}`, description: tool.description ?? tool.function?.description ?? "", parameters: schema ?? {} };
		norm.push(entry);
		// Stability/mutability are derived from the FULL serialized block
		// (name + description + parameters). Using the schema object alone let a
		// timestamp sitting in `description` through as MOSTLY_STATIC.
		const blockText = JSON.stringify({ name: entry.name, description: entry.description, parameters: schema ?? {} });
		blocks.push(
			createBlock({
				role: "system",
				kind: "tool_schema",
				text: blockText,
				stability: stabilityFor("tool_schema", blockText),
				mutability: mutabilityFor("tool_schema", blockText, stabilityFor("tool_schema", blockText)),
				priority: priorityFor("tool_schema"),
				provenance: { ...origin, section: `tools[${i}]` },
			}),
		);
	}
	return { norm, blocks };
}

function parseAnyJsonPayload(payload, origin) {
	let root = payload;
	if (typeof payload === "string") {
		try {
			root = JSON.parse(payload);
		} catch {
			return null;
		}
	}
	if (root == null || typeof root !== "object") return null;

	// Anthropic style: { system, messages, tools }
	if (Array.isArray(root.messages)) {
		const blocks = [];
		if (typeof root.system === "string" && root.system.trim()) {
			blocks.push(
				createBlock({
					role: "system",
					kind: "instruction",
					text: root.system.trim(),
					stability: stabilityFor("instruction", root.system.trim()),
					mutability: mutabilityFor("instruction", root.system.trim(), stabilityFor("instruction", root.system.trim())),
					priority: "P0",
					provenance: { ...origin, section: "system" },
				}),
			);
		}
		const { blocks: toolBlocks } = parseTools(root.tools, origin);
		blocks.push(...toolBlocks);
		blocks.push(...parseMessages(root.messages, origin));
		return { blocks, tools: toolBlocks.map((b) => JSON.parse(b.text)) };
	}

	// OpenAI style: { messages: [...] }
	if (Array.isArray(root.messages)) {
		return { blocks: parseMessages(root.messages, origin), tools: [] };
	}

	// MCP tools/list: { tools: [...] } or { functions: [...] }
	const tools = root.tools ?? root.functions;
	if (Array.isArray(tools)) {
		const { norm, blocks } = parseTools(tools, origin);
		return { blocks, tools: norm };
	}

	return null;
}

/**
 * Top-level parse entry. `sourceType` may be one of:
 *   markdown | messages | anthropic | openai | tools | system_prompt | user_prompt
 * When omitted it is detected from shape.
 */
export function parsePrompt(input, { sourceType, provider = null, model = null, origin = {}, projectId = null } = {}) {
	const content = typeof input === "string" ? input : JSON.stringify(input);
	let actualType = sourceType;
	let parsed = null;

	if (!actualType && typeof input === "string") {
		const maybeJson = input.trim().startsWith("{") || input.trim().startsWith("[") || input.trim().startsWith("```json");
		if (maybeJson) parsed = parseAnyJsonPayload(input, origin);
		actualType = parsed ? "json" : "markdown";
	}
	if (actualType === "markdown" || actualType === "system_prompt" || actualType === "user_prompt" || actualType === "agents_md" || actualType === "claude_md" || actualType === "cursor_rules" || actualType === "skill_md") {
		const blocks = parseMarkdown(content, {
			defaultRole: actualType === "user_prompt" ? "user" : "system",
			origin,
		});
		if (actualType === "user_prompt" && blocks.length > 0) {
			blocks[blocks.length - 1].role = "user";
			blocks[blocks.length - 1].kind = "user_request";
			blocks[blocks.length - 1].mutability = "DO_NOT_TOUCH";
			blocks[blocks.length - 1].stability = "DYNAMIC";
			blocks[blocks.length - 1].priority = "P0";
		}
		return createManifest({
			sourceType: actualType,
			provider,
			model,
			projectId,
			content,
			blocks,
			metadata: { bytes: Buffer.byteLength(content, "utf8") },
		});
	}

	if (!parsed && actualType !== "markdown") parsed = parseAnyJsonPayload(input, origin);
	if (!parsed) {
		// Fallback: string that failed to parse as JSON → treat as markdown.
		return parsePrompt(content, { sourceType: "markdown", provider, model, origin, projectId });
	}
	return createManifest({
		sourceType: actualType ?? "json",
		provider,
		model,
		projectId,
		content,
		blocks: parsed.blocks,
		tools: parsed.tools ?? [],
		metadata: { bytes: Buffer.byteLength(content, "utf8") },
	});
}

// ─── serializers (spec §51 Step 11 export family; MVP covers the core) ───

/** Markdown export: heading per block kind, fenced tool schemas stay fenced. */
export function serializeToMarkdown(manifest) {
	const out = [];
	const label = {
		rule: "## Rules",
		instruction: "## Instructions",
		example: "## Examples",
		project_contract: "## Project",
		repo_map: "## Repo Map",
		tool_schema: "## Tools",
		user_request: "## User Request",
		code: "## Code",
	};
	for (const b of manifest.blocks ?? []) {
		if (label[b.kind]) out.push(label[b.kind]);
		out.push(b.text);
		out.push("");
	}
	return out.join("\n").trimEnd() + "\n";
}

/** OpenAI-style messages array. */
export function serializeToMessages(manifest) {
	const messages = [];
	for (const b of manifest.blocks ?? []) {
		const role = b.role === "tool" ? "tool" : b.role === "user" ? "user" : "assistant";
		messages.push({ role, content: b.text });
	}
	return messages;
}

/** Anthropic-style request: { system, messages, tools }. */
export function serializeToAnthropic(manifest) {
	const systemParts = [];
	const messages = [];
	for (const b of manifest.blocks ?? []) {
		if (b.role === "system") systemParts.push(b.text);
		else messages.push({ role: b.role === "user" ? "user" : "assistant", content: b.text });
	}
	const out = { system: systemParts.join("\n"), messages };
	if (manifest.tools?.length) out.tools = manifest.tools;
	return out;
}

/** Prompt fingerprint summary (short form used by /promptLab/fingerprint). */
export function serializeFingerprint(fingerprint) {
	return fingerprint;
}

/** One-line human identifier of a manifest. */
export function manifestLabel(manifest) {
	const tokens = (manifest.blocks ?? []).reduce((a, b) => a + (b.tokenCount?.count ?? 0), 0);
	return `${manifest.promptId} · ${manifest.blocks?.length ?? 0} blocks · ~${tokens} tokens`;
}

export { createBlock, createManifest, sha256 };