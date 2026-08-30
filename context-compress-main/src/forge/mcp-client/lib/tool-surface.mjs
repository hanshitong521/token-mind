import { isRelease } from "./release.mjs";

/** Optional override of env TOKEN_SKILL_PROJECT_ID (tenants.json must allow the id or "*"). */
const PROJECT_PARAM = {
  project: {
    type: "string",
    description:
      "Knowledge project id (default: TOKEN_SKILL_PROJECT_ID). Generic corpus when no ingest-policy-<id>.yaml.",
  },
};

const SEARCH_TOOL = {
  name: "semantic_search",
  description: isRelease()
    ? [
        "Project docs/memory/pitfalls only. Pass query only.",
        "SKIP (use Read/@path): user names a .md file. SKIP: Java/code → CodeGraph; SQL → MySQL MCP.",
        "Production default: minimal or format=auto + token_budget/max_tokens. Follow-ups → get_evidence(F-xxxx).",
      ].join(" ")
    : [
        "检索项目知识库（默认 shejiu-docs）。只传 query。",
        "用户点名 .md → Read/@file。Java/Mapper → CodeGraph。SQL → ads-mysql。",
        "追问已返回证据 → get_evidence(F-xxxx)，勿重复 embedding。",
      ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "知识/口径/决策/流程；或证据 ID F-xxxx",
      },
      ...PROJECT_PARAM,
    },
    required: ["query"],
  },
};

const GET_EVIDENCE_TOOL = {
  name: "get_evidence",
  description: isRelease()
    ? "Return cached evidence by F-xxxx. No re-embedding. Repeat semantic_search only on miss."
    : "按 F-xxxx 取会话内已缓存证据。仅 miss 或明确要求重查时才 semantic_search。",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Evidence ID，如 F-8A21" },
    },
    required: ["id"],
  },
};

const GATE_TOOL_RESULT = {
  name: "gate_tool_result",
  description: isRelease()
    ? "Compress/dedup/budget large tool output before it enters agent context."
    : "任意工具回包闸门：Normalize → Dedup → Compress → Budget。",
  inputSchema: {
    type: "object",
    properties: {
      payload: { type: "string", description: "原始工具返回文本" },
      resource_id: { type: "string", description: "如 src/foo.mjs 或 mcp:mysql:query" },
      source_type: { type: "string" },
      kind: { type: "string" },
      max_tokens: { type: "number" },
      dedup: { type: "boolean" },
      file_path: { type: "string" },
    },
    required: ["payload"],
  },
};

const INDEX_STATUS_TOOL = {
  name: "semantic_index_status",
  description: isRelease()
    ? "Knowledge service readiness."
    : "Cloud project index metadata: status, version, chunk count, model.",
  inputSchema: { type: "object", properties: { ...PROJECT_PARAM } },
};

const ADMIN_TOOLS = [
  {
    name: "semantic_rebuild_index",
    description: "Enqueue a full index rebuild (async).",
    inputSchema: {
      type: "object",
      properties: {
        ...PROJECT_PARAM,
        wait: { type: "boolean" },
        timeout_seconds: { type: "number" },
      },
    },
  },
  {
    name: "semantic_ingest_documents",
    description: "Upload markdown into raw corpus. Then semantic_rebuild_index.",
    inputSchema: {
      type: "object",
      properties: {
        ...PROJECT_PARAM,
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      },
      required: ["files"],
    },
  },
];

const CORE_TOOLS = [SEARCH_TOOL, GET_EVIDENCE_TOOL, GATE_TOOL_RESULT, INDEX_STATUS_TOOL];

/** 默认不把 ingest/rebuild 挂进工具表；TOKEN_SKILL_ADMIN_TOOLS=1 才露出。 */
export function listTools() {
  if (process.env.TOKEN_SKILL_ADMIN_TOOLS === "1") return [...CORE_TOOLS, ...ADMIN_TOOLS];
  return CORE_TOOLS;
}
