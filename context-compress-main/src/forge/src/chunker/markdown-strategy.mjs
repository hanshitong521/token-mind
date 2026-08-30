import { createHash } from "crypto";

/**
 * Markdown chunking strategy.
 * Chunks by heading hierarchy, preserving semantic structure.
 */
export class MarkdownChunkStrategy {
  supports(filePath) {
    return /\.(md|mdx|mdc|markdown)$/i.test(filePath);
  }

  chunk(filePath, content, options = {}) {
    const baseDir = options.baseDir || "";
    const relPath = baseDir ? filePath.replace(baseDir, "").replace(/^[/\\]+/, "") : filePath;
    const lines = content.split("\n");
    const chunks = [];

    // Parse heading hierarchy
    let currentHeadings = [];
    let currentStart = 0;
    let currentLines = [];
    let inCodeBlock = false;

    const flush = (endLine) => {
      if (currentLines.length === 0) return;
      const text = currentLines.join("\n").trim();
      if (!text) return;

      const heading = currentHeadings[currentHeadings.length - 1] || "";
      const headingPath = [...currentHeadings];
      const id = this._generateId(relPath, headingPath, text);
      const hash = this._hashContent(text);

      chunks.push({
        id,
        path: relPath,
        heading,
        headingPath,
        text,
        lineStart: currentStart + 1,
        lineEnd: endLine,
        scope: this._classifyScope(heading, text),
        content_hash: hash,
      });
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track code blocks
      if (line.trim().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
      }

      // Detect headings (only outside code blocks)
      if (!inCodeBlock) {
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
          // Flush previous section
          flush(i);

          const level = headingMatch[1].length;
          const title = headingMatch[2].trim();

          // Truncate heading stack to current level
          currentHeadings = currentHeadings.slice(0, level - 1);
          currentHeadings.push(title);
          currentStart = i;
          currentLines = [line];
          continue;
        }
      }

      currentLines.push(line);
    }

    // Flush last section
    flush(lines.length);

    return chunks;
  }

  _generateId(relPath, headingPath, content) {
    const hash = this._hashContent(content);
    const pathPart = relPath.replace(/[^a-zA-Z0-9]/g, "_");
    const headingPart = headingPath.join(" > ").replace(/[^a-zA-Z0-9> _-]/g, "");
    return `${pathPart}::${headingPart}::${hash}`;
  }

  _hashContent(content) {
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  _classifyScope(heading, text) {
    const h = heading.toLowerCase();
    if (h.includes("memory") || h.includes("remember") || h.includes("context")) return "memory";
    if (h.includes("skill") || h.includes("tool") || h.includes("capability")) return "skills";
    if (h.includes("rule") || h.includes("constraint") || h.includes("must")) return "rules";
    return "other";
  }
}
