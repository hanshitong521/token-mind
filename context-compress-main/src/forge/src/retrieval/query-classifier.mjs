import { tokenize } from "../lib/store.mjs";

const VERSION_RE = /\bv(1\d{2,3})\b/i;

export function classifyQuery(query, scopeHint) {
  const raw = String(query || "");
  const q = raw.toLowerCase();
  const terms = tokenize(raw);

  let answer_type = "unknown";
  let temporal_intent = "current";
  let explicit_historical_intent = false;
  let version_intent;

  const vm = raw.match(VERSION_RE);
  if (vm) version_intent = vm[1].toLowerCase();

  if (/历史|以前|归档|deprecated|superseded/.test(raw)) {
    explicit_historical_intent = true;
    temporal_intent = "historical";
  }
  if (version_intent && /report|测试|audit|accuracy|gate|token|efficiency|root cause/.test(q)) {
    explicit_historical_intent = true;
    temporal_intent = "historical";
  }

  if (/bench|性能|perf\b|latency|p95|p50/.test(q) && /list|products|brand|sql/.test(q)) {
    answer_type = "performance";
  } else if (/contextforge/.test(q) && /efficiency|root\s*cause/.test(q)) {
    answer_type = "test_report";
    temporal_intent = "historical";
    explicit_historical_intent = true;
  } else if (/test report|token accuracy|deep audit|验收报告|测试报告|doctor report/.test(q)) {
    answer_type = "test_report";
    // ponytail: test_report 是历史产物（快照），temporal_intent 必为 historical。
    //   否则 SUPERSEDED 的旧测试报告（如 v140）在 current intent 下被 lifecycle_override 禁为 FORBIDDEN，
    //   无法检索到明确指定的历史测试报告（S14 根因）。
    temporal_intent = "historical";
    explicit_historical_intent = true;
  } else if (/backfill|drift|财账|日报|回填/.test(raw)) {
    answer_type = "current_status";
  } else if (/口径|canonical|ssot|editor policy|pin|priority/.test(q)) {
    answer_type = "canonical_rule";
  } else if (/implement|改造|代码|mapper|serviceimpl/.test(q)) {
    answer_type = "implementation";
  } else if (
    /debug|报错|失败|修复|troubleshoot|pitfall|踩坑/.test(q)
    || /(^|[^a-z0-9-])fix([^a-z0-9-]|$)/i.test(q)
  ) {
    // ponytail: 禁止把 hyphenated 文件名里的 "fix"（ads-sql-fix-playbook）当 troubleshooting。
    //   否则 INFORMATIONAL DAILY 被 FORBIDDEN，Top1 塌到 pitfalls。
    answer_type = "troubleshooting";
  } else if (/benchmark|golden path|session replay/.test(q)) {
    answer_type = "benchmark";
  }

  if (explicit_historical_intent && answer_type === "unknown") {
    answer_type = "historical";
  }

  const classification_confidence = answer_type === "unknown" ? 0.35 : 0.72;

  return {
    answer_type,
    temporal_intent,
    explicit_historical_intent,
    version_intent,
    risk_level: "LOW",
    classification_confidence,
    scope_hint: scopeHint,
  };
}
