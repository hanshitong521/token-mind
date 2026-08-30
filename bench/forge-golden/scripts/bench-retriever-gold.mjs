#!/usr/bin/env node
/**
 * Retriever Gold Benchmark（v1.5 §7/§8：真实 Gold Dataset + 检索质量基准）。
 *
 *   node scripts/bench-retriever-gold.mjs                 # lexical 模式（确定性，无外部依赖）
 *   node scripts/bench-retriever-gold.mjs --semantic      # 尝试 Ollama 语义模式（不可达自动回退 lexical）
 *   node scripts/bench-retriever-gold.mjs --ci            # 与 state/current-baseline.json 对比，Recall@5 跌 >2pp 即 FAIL
 *   node scripts/bench-retriever-gold.mjs --save-baseline # 把本次结果写入基线
 *   node scripts/bench-retriever-gold.mjs --compare '{"topK":10}' '{"topK":15}'  # 两种策略的 bootstrap CI 对比
 *   node scripts/bench-retriever-gold.mjs --compare '{"topK":10}' --negative-test  # 负对照：同配置应 INCONCLUSIVE
 *
 * 语料 = 本仓库真实文件（docs / _docs_source / src / mcp-client / scripts / test / 根目录文档）。
 * 指标 = Recall@1/3/5 + MRR + NDCG@5，path-level 匹配，排序口径 = raw_hits（过滤后、Gate 前）。
 *
 * VENDORED（work-mind @19cbfff → Token-Mind）：golden/基线/contract 数据已随仓库保存，
 * 但本 harness 的语料仍绑定 work-mind 自身仓库布局——直接运行会在语料收集阶段报空。
 * P5 启动时需把 CORPUS_DIRS/ROOT_FILES/GOLD 路径改指 Token-Mind 目标语料后才可跑。
 */
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { chunkFile, collectSupportedFiles } from "../../../context-compress-main/src/forge/src/chunker/strategy.mjs";
import { searchIndex, lexicalProbe } from "../../../context-compress-main/src/forge/src/lib/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOLD = path.join(ROOT, ".contextforge", "benchmarks", "golden", "retriever-gold.json");
const STATE_DIR = path.join(ROOT, ".contextforge", "state");
const PERF_DIR = path.join(ROOT, ".contextforge", "benchmarks", "performance");
const MIN_RECALL_AT_5 = 0.98;

const CORPUS_DIRS = [
  "docs",
  "src",
  "mcp-client/lib",
  "mcp-client/scripts",
  "scripts",
  "test",
];
const ROOT_FILES = ["README.md", "DEV-STATUS.md"];

function collectRootMarkdown() {
  const out = [];
  for (const name of fs.readdirSync(ROOT)) {
    if (!/\.md$/i.test(name) || name.startsWith(".")) continue;
    out.push(path.normalize(path.join(ROOT, name)));
  }
  return out;
}

export function buildCorpusIndex() {
  const files = [];
  for (const d of CORPUS_DIRS) {
    files.push(...collectSupportedFiles([path.join(ROOT, d)]));
  }
  const rootMd = new Set(collectRootMarkdown());
  for (const f of ROOT_FILES) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) rootMd.add(path.normalize(full));
  }
  files.push(...rootMd);
  const chunks = [];
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, "/");
    const content = fs.readFileSync(abs, "utf8");
    for (const c of chunkFile(rel, content)) chunks.push(c);
  }
  return { files: files.length, chunks };
}

export function corpusRoot() {
  return ROOT;
}

export async function embedAvailable() {
  try {
    const host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const wantSemantic = process.argv.includes("--semantic");
  const ci = process.argv.includes("--ci");
  const saveBaseline = process.argv.includes("--save-baseline");
  const compareIdx = process.argv.indexOf("--compare");
  const compareMode = compareIdx >= 0;
  const negativeTest = process.argv.includes("--negative-test");

  const gold = JSON.parse(fs.readFileSync(GOLD, "utf8"));
  const index = buildCorpusIndex();
  console.log(`Corpus: ${index.files} files → ${index.chunks.length} chunks | queries: ${gold.queries.length}`);

  // 校验 gold 标注的路径都在语料里（防标注漂移）
  const corpusPaths = new Set(index.chunks.map((c) => String(c.path).replace(/\\/g, "/")));
  const badLabels = [];
  for (const q of gold.queries) {
    for (const p of q.expect) if (!corpusPaths.has(p)) badLabels.push(`${q.id}: ${p}`);
  }
  if (badLabels.length) {
    console.error("BAD GOLD LABELS (path not in corpus):\n  " + badLabels.join("\n  "));
    process.exit(1);
  }

  let mode = "lexical";
  if (wantSemantic && (await embedAvailable())) {
    const { embedTexts, embedText } = await import("../src/lib/embed.mjs");
    console.log("Embedding corpus (semantic mode)...");
    const t0 = Date.now();
    const vecs = await embedTexts(index.chunks.map((c) => c.text));
    index.chunks = index.chunks.map((c, i) => ({ ...c, embedding: vecs[i] }));
    mode = "semantic";
    console.log(`  embedded ${vecs.length} chunks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const results = [];
    for (const q of gold.queries) {
      // 生产同款管线：lexicalProbe 先行，强词法命中跳过 embedding（lex-first）
      const probe = lexicalProbe(index, q.query, { topK: 10, minScore: 0.05 });
      const queryVec = probe.skipEmbed ? null : await embedText(q.query).catch(() => null);
      results.push(evaluate(q, index, queryVec));
    }
    report(gold, index, mode, results, { saveBaseline, ci });
    return;
  }
  if (wantSemantic) console.log("Ollama unreachable — falling back to lexical mode");

  if (compareMode) {
    const configA = JSON.parse(process.argv[compareIdx + 1]);
    let configB;
    if (negativeTest) {
      configB = configA; // identical config — expect INCONCLUSIVE
      console.log("\n[NEGATIVE TEST] Comparing identical configs (expect INCONCLUSIVE)");
    } else {
      configB = JSON.parse(process.argv[compareIdx + 2]);
    }
    const resultsA = gold.queries.map((q) => evaluate(q, index, null, configA));
    const resultsB = gold.queries.map((q) => evaluate(q, index, null, configB));
    compareReport(gold, resultsA, resultsB, configA, configB);
    return;
  }

  const results = gold.queries.map((q) => evaluate(q, index, null));
  report(gold, index, mode, results, { saveBaseline, ci });
}

function evaluate(q, index, queryVec, config = {}) {
  const r = searchIndex(index, queryVec, {
    query: q.query,
    topK: config.topK ?? 10,
    minScore: config.minScore ?? 0.05,
    withMeta: true,
    withRawHits: true,
  });
  const ranked = (r.raw_hits || r.hits || []).map((h) => String(h.path).replace(/\\/g, "/"));
  const expect = new Set(q.expect);
  const rel = ranked.map((p) => (expect.has(p) ? 1 : 0));
  const firstHit = rel.indexOf(1); // -1 = miss
  return {
    id: q.id,
    type: q.type,
    recall1: firstHit === 0 ? 1 : 0,
    recall3: firstHit >= 0 && firstHit < 3 ? 1 : 0,
    recall5: firstHit >= 0 && firstHit < 5 ? 1 : 0,
    mrr: firstHit >= 0 ? 1 / (firstHit + 1) : 0,
    ndcg5: ndcg(rel, 5),
    top1: ranked[0] || null,
  };
}

function report(gold, index, mode, results, { saveBaseline, ci }) {
  const n = results.length || 1;
  const avg = (f) => results.reduce((a, r) => a + f(r), 0) / n;
  const byType = {};
  for (const r of results) {
    byType[r.type] ??= { n: 0, r5: 0 };
    byType[r.type].n++;
    byType[r.type].r5 += r.recall5;
  }
  const summary = {
    mode,
    date: new Date().toISOString().slice(0, 10),
    corpus_files: index.files,
    corpus_chunks: index.chunks.length,
    queries: results.length,
    recall_at_1: +avg((r) => r.recall1).toFixed(4),
    recall_at_3: +avg((r) => r.recall3).toFixed(4),
    recall_at_5: +avg((r) => r.recall5).toFixed(4),
    mrr: +avg((r) => r.mrr).toFixed(4),
    ndcg_at_5: +avg((r) => r.ndcg5).toFixed(4),
    by_type: Object.fromEntries(
      Object.entries(byType).map(([t, v]) => [t, { n: v.n, recall_at_5: +(v.r5 / v.n).toFixed(4) }]),
    ),
  };

  console.log(`\n=== Retriever Gold Benchmark (${mode}) ===`);
  console.log(`Recall@1=${(summary.recall_at_1 * 100).toFixed(1)}%  Recall@3=${(summary.recall_at_3 * 100).toFixed(1)}%  Recall@5=${(summary.recall_at_5 * 100).toFixed(1)}%`);
  console.log(`MRR=${summary.mrr.toFixed(3)}  NDCG@5=${summary.ndcg_at_5.toFixed(3)}`);
  for (const [t, v] of Object.entries(summary.by_type)) {
    console.log(`  [${t}] n=${v.n} Recall@5=${(v.recall_at_5 * 100).toFixed(1)}%`);
  }
  const misses = results.filter((r) => !r.recall5);
  if (misses.length) {
    console.log(`\nMisses (Recall@5=0): ${misses.map((m) => m.id).join(", ")}`);
    for (const m of misses) console.log(`  ${m.id} top1=${m.top1}`);
  }

  fs.mkdirSync(PERF_DIR, { recursive: true });
  const reportPath = path.join(PERF_DIR, `retriever-gold-${mode}-${summary.date}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ summary, results }, null, 2));
  console.log(`\nReport: ${path.relative(ROOT, reportPath)}`);

  if (saveBaseline) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const statePath = path.join(STATE_DIR, "current-baseline.json");
    const state = fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, "utf8"))
      : {};
    const key = mode === "semantic" ? "retriever_gold_semantic" : "retriever_gold_lexical";
    state[key] = { ...summary, report: path.relative(ROOT, reportPath) };
    if (mode === "semantic") state.retriever_gold = state[key];
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log(`Baseline saved → ${path.relative(ROOT, statePath)} (${key})`);
  }

  if (ci) {
    const statePath = path.join(STATE_DIR, "current-baseline.json");
    if (!fs.existsSync(statePath)) {
      console.log("CI: no baseline yet — run with --save-baseline first (skipping threshold check)");
      return;
    }
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const key = mode === "semantic" ? "retriever_gold_semantic" : "retriever_gold_lexical";
    const base =
      state[key]?.recall_at_5 ??
      (mode === "semantic" ? state.retriever_gold?.recall_at_5 : undefined);
    if (typeof base !== "number") {
      console.log("CI: baseline has no retriever_gold.recall_at_5 — skipping");
      return;
    }
    const drop = base - summary.recall_at_5;
    if (drop > 0.02) {
      console.error(`CI FAIL: Recall@5 ${(summary.recall_at_5 * 100).toFixed(1)}% dropped ${(drop * 100).toFixed(1)}pp below baseline ${(base * 100).toFixed(1)}%`);
      process.exit(1);
    }
    if (summary.recall_at_5 + 1e-9 < MIN_RECALL_AT_5) {
      console.error(`CI FAIL: Recall@5 ${(summary.recall_at_5 * 100).toFixed(1)}% < floor ${(MIN_RECALL_AT_5 * 100).toFixed(0)}%`);
      process.exit(1);
    }
    console.log(`CI PASS: Recall@5 vs baseline ${(base * 100).toFixed(1)}% → ${(summary.recall_at_5 * 100).toFixed(1)}% (drop ${Math.max(0, drop * 100).toFixed(1)}pp ≤ 2pp; floor ${(MIN_RECALL_AT_5 * 100).toFixed(0)}%)`);
  }
}

function ndcg(rel, k) {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, rel.length); i++) {
    dcg += rel[i] / Math.log2(i + 2);
  }
  const ideal = [...rel].sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  for (let i = 0; i < ideal.length; i++) {
    idcg += ideal[i] / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

// ---- Statistical comparison (Phase 3: minimal bootstrap CI) ----

function bootstrapCI(diffs, iterations = 10000) {
  const n = diffs.length;
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += diffs[Math.floor(Math.random() * n)];
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const lower = means[Math.floor(iterations * 0.025)];
  const upper = means[Math.floor(iterations * 0.975)];
  return { lower, upper };
}

function compareReport(gold, resultsA, resultsB, configA, configB) {
  const diffs = resultsA.map((r, i) => r.recall5 - resultsB[i].recall5);
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const ci = bootstrapCI(diffs);

  const summaryA = {
    recall_at_1: avg(resultsA, (r) => r.recall1),
    recall_at_3: avg(resultsA, (r) => r.recall3),
    recall_at_5: avg(resultsA, (r) => r.recall5),
    mrr: avg(resultsA, (r) => r.mrr),
  };
  const summaryB = {
    recall_at_1: avg(resultsB, (r) => r.recall1),
    recall_at_3: avg(resultsB, (r) => r.recall3),
    recall_at_5: avg(resultsB, (r) => r.recall5),
    mrr: avg(resultsB, (r) => r.mrr),
  };

  let verdict;
  if (ci.lower > 0) verdict = "SUPPORTED (A > B)";
  else if (ci.upper < 0) verdict = "SUPPORTED (B > A)";
  else verdict = "INCONCLUSIVE";

  console.log(`\n=== Strategy Comparison ===`);
  console.log(`A: ${JSON.stringify(configA)}`);
  console.log(`B: ${JSON.stringify(configB)}`);
  console.log(`N: ${gold.queries.length} queries`);
  console.log(`\nA: Recall@5=${(summaryA.recall_at_5 * 100).toFixed(1)}%  MRR=${summaryA.mrr.toFixed(3)}`);
  console.log(`B: Recall@5=${(summaryB.recall_at_5 * 100).toFixed(1)}%  MRR=${summaryB.mrr.toFixed(3)}`);
  console.log(`\nΔ Recall@5: ${(meanDiff * 100).toFixed(2)}pp  95% CI: [${(ci.lower * 100).toFixed(2)}pp, ${(ci.upper * 100).toFixed(2)}pp]`);
  console.log(`\nVerdict: ${verdict}`);

  return { summaryA, summaryB, meanDiff, ci, verdict };
}

function avg(arr, f) {
  return arr.reduce((a, r) => a + f(r), 0) / arr.length;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
