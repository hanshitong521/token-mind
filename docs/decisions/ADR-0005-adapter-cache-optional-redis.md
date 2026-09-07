# ADR-0005: cache adapter 的 Redis 为可选后端，默认关闭

- 状态：ACCEPTED（2026-09-07）
- 决策来源：总规范零依赖原则（ADR-0004 理由 3）；`contextmind/lib/cache-engine/redis-io.mjs`
- **本文件系事后重建**：原件在 2026-09-07 21:49 的批量截断中被写成 2 字节（`\r\n`），
  git HEAD 与 `shejiuPro/.cursor` 镜像均无副本。以下内容依据现存实现代码复原，
  非原始行文；若与原意有出入，以代码为准并修订本 ADR。

## 背景

cache-engine 需要一个可跨进程复用的结果缓存。内存缓存（`cache.mem_max`）在单进程内足够，
但 MCP server、CLI 子进程、hooks 是三个独立进程，命中无法共享。
Redis 能解决共享，但引入它就要面对：依赖、连接失败、慢响应阻塞主流程。

## 决策

Redis 作为 **可选后端**，不是必需依赖：

1. 配置项 `cache.redis_url` 默认 **空字符串**（`config.mjs`），空即完全不走 Redis 路径。
2. `cache.backend` 默认 `"auto"`：有 `redis_url` 才尝试 Redis，否则回落内存缓存。
3. Redis 客户端 **手写 RESP 协议跑在 `node:net` 上**（`redis-io.mjs`），零 npm 依赖 ——
   不引入 `ioredis` / `redis` 包。
4. Redis 不是 `adapters` 的一员。`adapters` 只有 `codegraph` 与 `mysql`；
   Redis 属于 cache 后端的实现细节，不参与 adapter 实装探测。

## 理由

1. **失败必须静默降级，绝不能让缓存拖垮主流程。** `parseRedisUrl` 对缺失、非法 URL、
   非 `redis:`/`rediss:` 协议一律返回 `null`；`redisCall` 对 socket error 和超时
   （默认 **50ms**）一律 `resolve(null)` 并 `destroy()` 连接。调用方拿到 `null`
   就当未命中，继续正常执行 —— 与 ADR-0004 的 `ADAPTER_MISSING` 语义一致：
   任何失败都返回明确状态，禁止假装调用成功。
2. **零依赖架构延续。** 只需 GET / SET EX 两个命令，手写 ~40 行 RESP 编解码即可；
   引入 Redis SDK 换来的是 npm 依赖树 + 版本漂移，违反轻量原则。
3. **默认关闭 = 默认零风险。** 没配 `redis_url` 的用户不会莫名其妙去连 127.0.0.1:6379，
   也不会在没装 Redis 的机器上看到超时日志。
4. 一处实现两处复用：`redis-io.mjs` 同时服务 `result_cache` 与 cache-engine 的 L0 镜像，
   避免两套 Redis 逻辑口径不一致。

## 后果

- 跨进程缓存命中只在显式配置 `redis_url` 后生效；默认部署下三个进程各自持有内存缓存。
- 50ms 超时是硬上限，Redis 慢于此值即视为未命中 —— 宁可少命中，不可拖慢。
- `rediss:` 走 TLS 由 `parseRedisUrl` 标记，但当前 `redisCall` 用的是 `node:net.connect`，
  **尚未接 TLS 握手**；如需 `rediss:` 真正可用，须改走 `node:tls.connect`，届时另开 ADR。
- 语义缓存（`cache_engine.semanticCache`）默认 `false`，与本 ADR 的可选策略同向。
