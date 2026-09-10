# ADR-0010: Promptfoo as Eval Adapter（非核心 runtime dependency）

- 状态: Accepted
- 日期: 2026-09-09
- 决策人: owner（Prompt Lab 第一轮裁决 Q1=C、Q3=A）
- 关联: 《Token-Mind Prompt Lab 开发总规范》§27、§41、§49；ADR-0007

## 背景

规范 §27 将 Promptfoo 列为"第一阶段必装"，§49 将 `promptfoo CLI/API adapter`
列为 Eval 依赖。现状与约束：

1. 仓库零运行时依赖；promptfoo 是 pnpm workspace 的大型 TypeScript 应用，
   以 devDependency 引入即产生大体积依赖树。
2. 本仓库不重复造通用 LLM Eval 平台 —— 只做 Token-Mind 特有指标
   （Cache Stability / Stable Prefix / Fingerprint Drift / Token Breakdown /
   Prompt Risk / Rule Retention），二者是组合关系，不是依赖关系。
3. 用户裁决：Prompt Lab Core（parse/analyze/score/fingerprint/detect cache drift）
   **不得依赖** Promptfoo 才能运行。

## 决策

1. Promptfoo = 一个 **Eval Provider**，通过 adapter 契约接入，永不成为
   Prompt Lab Core 的 import 依赖。本轮（Step 0–4）不安装、不 npm install。
2. 冻结 Eval 抽象为：

```text
EvalProvider
├─ BuiltinEvaluator          （未来：本地/确定性断言，离线可用）
├─ PromptfooAdapter          （future adapter：CLI/API，未安装时明确降级）
└─ FutureCustomAdapter
```

3. "Promptfoo 未安装" 是**可表示的显式状态**：Eval 页面/报告显示
   `eval_provider: PROMPTFOO_NOT_INSTALLED`，critical assertions 保持 UNKNOWN，
   gate 不得 recommend —— 不允许静默跳过假装通过（延续三态 gate 原则）。
4. `promptfoo-main/` 源码仅作参考（config/providers/assertions 形态），留在
   Downloads 参考目录，不进仓库。

## 后果

- 优点：Prompt Lab Core 零第三方依赖；未装 Eval 工具时产品仍完整可用且诚实。
- 代价：Eval 执行能力推迟到接 PromptfooAdapter 之后（Step 9）；无法自动跑 provider matrix。
- 回退：若离线 BuiltinEvaluator 被证明足以覆盖断言需求，PromptfooAdapter 可降级为可选。
