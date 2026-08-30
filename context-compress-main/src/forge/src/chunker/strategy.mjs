/**
 * Chunk Strategy Interface.
 * All chunkers must implement this contract.
 */
import fs from "fs";
import path from "path";
import { MarkdownChunkStrategy } from "./markdown-strategy.mjs";
import { logger } from "../observability/logger.mjs";

/**
 * @typedef {object} Chunk
 * @property {string} id - Stable chunk ID
 * @property {string} path - Relative file path
 * @property {string} heading - Section heading
 * @property {string[]} headingPath - Heading hierarchy
 * @property {string} text - Chunk text content
 * @property {number} lineStart - Start line number
 * @property {number} lineEnd - End line number
 * @property {string} scope - Scope classification
 * @property {string} content_hash - Content hash for dedup
 */

let strategies = null;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", "__pycache__"]);

function getChunkingStrategies() {
  if (strategies) return strategies;
  strategies = [new MarkdownChunkStrategy()];
  return strategies;
}

export function getStrategyForFile(filePath) {
  for (const strategy of getChunkingStrategies()) {
    if (strategy.supports(filePath)) return strategy;
  }
  return null;
}

export function chunkFile(filePath, content, options = {}) {
  const strategy = getStrategyForFile(filePath);
  if (!strategy) {
    logger.debug({ filePath }, "No chunking strategy found, skipping");
    return [];
  }
  return strategy.chunk(filePath, content, options);
}

export function isSupportedFile(filePath) {
  return getStrategyForFile(filePath) !== null;
}

export function getSupportedExtensions() {
  return [".md", ".mdx", ".markdown", ".mdc"];
}

export function collectSupportedFiles(roots) {
  const out = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const st = fs.statSync(root);
    if (st.isFile()) {
      if (isSupportedFile(root)) out.push(path.normalize(root));
      continue;
    }
    walkDir(root, out);
  }
  return out.sort();
}

function walkDir(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".cursor") continue;
      walkDir(full, out);
    } else if (entry.isFile() && isSupportedFile(full)) {
      out.push(path.normalize(full));
    }
  }
}
