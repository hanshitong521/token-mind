/**
 * Parse Cursor agent transcript JSONL → ordered tool events.
 */
import fs from "fs";

const FORGE_TOOLS = new Set([
  "semantic_search",
  "get_evidence",
  "semantic_index_status",
  "semantic_rebuild_index",
  "semantic_ingest_documents",
]);

function normalizeToolEvent(name, input) {
  const raw = input || {};
  if (name === "CallMcpTool") {
    const toolName = raw.toolName || raw.tool_name || "";
    const args = raw.arguments || raw.args || {};
    return {
      kind: "mcp",
      mcpServer: raw.server || "",
      tool: toolName,
      query: String(args.query || args.q || ""),
      evidenceId: String(args.id || args.evidence_id || ""),
      input: raw,
    };
  }
  if (name === "Task") {
    return {
      kind: "task",
      tool: "Task",
      subagent: raw.subagent_type || raw.subagentType || "",
      input: raw,
    };
  }
  return {
    kind: "native",
    tool: name,
    path: raw.path || "",
    input: raw,
  };
}

function extractContentBlocks(obj) {
  const blocks = [];
  if (Array.isArray(obj?.message?.content)) {
    blocks.push(...obj.message.content);
  }
  if (Array.isArray(obj?.content)) {
    blocks.push(...obj.content);
  }
  return blocks;
}

export function parseTranscriptFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return parseTranscriptText(filePath, text);
}

export function parseTranscriptText(filePath, text) {
  const bytes = Buffer.byteLength(text, "utf8");
  const events = [];
  let parseErrors = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const role = row.role || row.message?.role;
      if (role !== "assistant") continue;
      for (const block of extractContentBlocks(row)) {
        if (block?.type !== "tool_use" && block?.type !== "tool_call") continue;
        const name = block.name || block.tool || "";
        const input = block.input || block.arguments || {};
        const ev = normalizeToolEvent(name, input);
        ev.lineHint = events.length;
        events.push(ev);
      }
    } catch {
      parseErrors += 1;
    }
  }
  return { path: filePath, bytes, events, parseErrors };
}

export function isForgeSearchTool(ev) {
  return ev.kind === "mcp" && ev.tool === "semantic_search";
}

export function isForgeEvidenceTool(ev) {
  return ev.kind === "mcp" && ev.tool === "get_evidence";
}

export function isCodegraphTool(ev) {
  return (
    (ev.kind === "mcp" &&
      (ev.tool === "codegraph_explore" ||
        /codegraph/i.test(ev.mcpServer || ""))) ||
    ev.tool === "codegraph_explore"
  );
}

export function isMysqlTool(ev) {
  return (
    ev.kind === "mcp" &&
    (ev.tool === "mysql_query" || /mysql/i.test(ev.mcpServer || ""))
  );
}

export function classifyTranscriptTool(ev) {
  if (isForgeSearchTool(ev)) return "forge_search";
  if (isForgeEvidenceTool(ev)) return "forge_evidence";
  if (isCodegraphTool(ev)) return "cg";
  if (isMysqlTool(ev)) return "mysql";
  if (ev.tool === "Read") return "read";
  if (ev.tool === "Grep") return "grep";
  if (ev.tool === "Task") return "task";
  if (ev.kind === "mcp" && FORGE_TOOLS.has(ev.tool)) return "forge_admin";
  return "other";
}
