# Ultimate Cache Engine（实现指针）

真源规范（用户本机）：

`C:\Users\Administrator\Downloads\Token-Mind_Ultimate_Cache_Engine_开发总规范.md`

参考项目目录（只借机制，不 vendor 整仓）：

`C:\Users\Administrator\Downloads\66666`（Aider / GPTCache / LLMLingua / LMCache / LiteLLM / vLLM / SGLang 等）

## 本仓落地位置

| 规范 § | 代码 |
|--------|------|
| §5 目录 | `contextmind/lib/cache-engine/`、`lib/prompt-pipeline.mjs`、`lib/context/delta-context.mjs`、`lib/brain/brain-sync.mjs`、`lib/db/schema.mjs` |
| §22 Hook | `cursor/hooks/cm-before-submit-prompt.mjs` |
| §25 Doctor | `contextmind doctor cache` + 全量 `doctor` 中的 cache 行 |
| Brain §18 | `brain-sync.mjs`（默认关；`cache_engine.brainSync`） |

## 开发顺序（规范 §30）

Step 8–12 + **巅峰 peak（2026-09-06）**：

- `cache_engine.peak: true` → `miss_only` Stable、Semantic L4、L2 pre-deny、`brainSyncOnStop` 队列
- `lib/cache-engine/pre-tool-l2.mjs`：相同 `context_*` 参数命中 L2 则 pre-tool deny + handle 指引
- `prompt-pipeline`：L1 warm 时同样跳过 Stable Prefix
- `CONTEXTMIND_CACHE_TTL_SEC` 环境变量；`install` 后 `resetConfig()` 刷新 hook 配置缓存

- `cache-context.mjs`：TaskBundle 指纹统一 L0/L1 键；只缓存「定位/解释」类 prompt
- `cache-stop.mjs` + `cm-stop`：每轮 stop 写 L0（handle 指针）+ L1（session seen 资源包）+ gc
- `prompt-pipeline`：L0 + L1 注入；session delta 用 `session_seen` 表
- `cm-post-tool`：MCP `context_*` 成功写 L2 tool_cache
- `cm-session-end`：关闭前 `cacheEngine.gc()`

## 验证

```powershell
cd E:\workA\A-skill\Token-Mind
node --test contextmind/tests/cache-engine.test.mjs
node contextmind/cli.mjs doctor cache E:\workA\shejiuPro
node contextmind/cli.mjs install E:\workA\shejiuPro
```

安装后 Reload Cursor；`project-brain` 仍只承担 WHY 五工具（见 `project-brain-agent/docs/STACK-CONTRACT.md`）。
