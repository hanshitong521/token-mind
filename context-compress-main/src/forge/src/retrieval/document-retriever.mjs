/**
 * FullScanDocumentRetriever (§7, §10) — Document-first retrieval, NO chunk.
 *
 * spec §6/§7:
 *   - Document candidate 由 document lexical + document dense 产生
 *   - 禁止 chunk score 聚合后声称是 Document Retrieval (§31)
 *   - 禁止使用 first chunk embedding / avg chunk embeddings / max chunk score 代表 Document
 *   - document embedding = embedding(document.retrieval_text) — 已在 rebuild-v2 生成
 *
 * Invariant 1: Document Candidate 产生阶段不得读取 Chunk Ranking Score
 * Invariant 2: Top Documents 未确定前不允许 Chunk Retrieval
 *
 * ponytail: 单文件，stdlib only。复用 store.mjs 的 tokenize/lexicalScore。
 */
import { tokenize, lexicalScore, cosine, norm } from "../lib/store.mjs";

/**
 * Score a document against query.
 * @param {object} doc - DocumentRecord (含 retrieval_text, embedding via document_embeddings)
 * @param {string} query
 * @param {Float32Array} queryVec - query embedding
 * @param {Float32Array} docEmbeddings - flat doc embeddings array
 * @param {number} dim
 * @param {number} docIdx - document index in docEmbeddings
 * @returns {{ lexical: number, dense: number, fused: number }}
 */
export function scoreDocument(doc, query, queryVec, docEmbeddings, dim, docIdx) {
  // Document lexical score against retrieval_text
  const lexical = lexicalScore(query, doc.retrieval_text || "");

  // Document dense score (cosine)
  let dense = 0;
  if (queryVec && docEmbeddings && docEmbeddings.length >= (docIdx + 1) * dim) {
    const emb = docEmbeddings.subarray(docIdx * dim, (docIdx + 1) * dim);
    dense = cosine(queryVec, emb);
  }

  // Fused: 0.5 lexical + 0.5 dense (v1 first version, can tune later)
  const fused = 0.5 * lexical + 0.5 * dense;
  return { lexical, dense, fused };
}

/**
 * FullScanDocumentRetriever — scan all documents, return top-N by fused score.
 *
 * @param {object} args
 *   documents: DocumentRecord[]
 *   query: string
 *   queryVec: Float32Array | null
 *   document_embeddings: Float32Array (flat)
 *   dim: number
 *   topN: number (default 20)
 *   minScore: number (default 0.05)
 * @returns {{ candidates: Array<{ document, lexical, dense, fused, rank }> }}
 */
export function retrieveDocuments({
  documents,
  query,
  queryVec,
  document_embeddings,
  dim,
  topN = 20,
  minScore = 0.05,
}) {
  const scored = documents.map((doc, idx) => {
    const s = scoreDocument(doc, query, queryVec, document_embeddings, dim, idx);
    return { document: doc, ...s, idx };
  });

  // Filter by minScore (either lexical or dense must be > 0)
  const filtered = scored.filter(
    (s) => s.fused > 0 || s.lexical > 0 || s.dense > 0,
  );

  filtered.sort((a, b) => b.fused - a.fused);

  return {
    candidates: filtered.slice(0, topN).map((c, i) => ({
      document: c.document,
      lexical: c.lexical,
      dense: c.dense,
      fused: c.fused,
      rank: i + 1,
    })),
    total_scored: scored.length,
    total_passed: filtered.length,
  };
}
