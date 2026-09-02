# ADR-0002: 配置用 JSON 单文件，不引入 YAML（偏离二轮默认"yaml 单文件"）

- 状态: Accepted
- 日期: 2026-09-01
- 关联: DECISIONS-2026-09-01（二轮默认"配置：yaml 单文件"）、spec §26 / §29.6

## 背景

owner 在二轮默认里写"配置：yaml 单文件"，并明示可由开发窗内自定。spec §26 的 YAML 是"例如"给出的示例，而 §29.6 是硬规则："不允许 20 个环境变量和 4 个 yaml 相互覆盖到无法理解"、"无重复配置源"。

仓库现状：被驱动的引擎 context-compress 已经读取 `~/.context-compress.json` + `<project>/.context-compress.json` 双层 JSON。ContextMind 层若另起 YAML，意味着：新增一个运行时依赖（Node 无内置 YAML；DEEP-DEV-PLAN 红线"不引入任何 npm 新依赖"）、两套配置文件、两套加载与校验逻辑。

## 决策

ContextMind 配置 = 单一 JSON 源，双层：

- 用户层 `~/.contextmind.json`
- 项目层 `<project>/.contextmind.json`
- 优先级 env > project > user > defaults（与引擎一致）
- 项目层不可设置 `handles` / `telemetry`（与引擎的 USER_SCOPE_ONLY_KEYS 同理：随仓库来的文件不可信）

## 后果

- 换来：零新依赖、单一事实源、与引擎同构的心智模型、`doctor` 只需检查一种文件。
- 代价：放弃 YAML 注释与多行字符串；偏离 owner 二轮默认（本 ADR 即为记录）。
- 回退条件：若出现第二个消费方确需 YAML（如人工维护的大段规则表），再评估，且必须同时删掉 JSON 层，不允许并存。
