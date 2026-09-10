/**
 * symbols.mjs — 符号级 outline 扫描器（Serena 核心经验的零依赖提炼）。
 *
 * 思路来自 serena-main 的 GetSymbolsOverviewTool / symbol.py：只返回文件的
 * 符号结构（kind + name_path + 行号范围），默认不带函数体，让 Agent 不必整读
 * 文件就能定位目标行，再按需 bounded Read。这里是纯 Node 实现，零运行时依赖
 * （ADR-0001），并发安全（无模块级可变状态，一切分配都在调用内完成）。
 *
 * 两个引擎：
 *  - Java 单遍扫描：O(n) 词法状态机，跳过字符串/字符/注释/文本块/注解/泛型，
 *    用花括号栈 + 头缓冲区判符号；方法 vs 控制块用「成员上下文 + 平衡参数表」
 *    两条规则区分。
 *  - 通用兜底（非 .java）：缩进级(.py) 或 花括号级(.ts/.js)，粗粒度，一直可用。
 *
 * 任何非预期输入（未闭合注释/文本块/括号不匹配）都不会抛错——对应模式
 * 「消费到 EOF」即可，返回部分结果。
 */

const TYPE_KINDS = new Set(["class", "interface", "enum", "record"]);
const JAVA_RE = /\.java$/i;
const PY_RE = /\.py$/i;

/** 序列化/扫描的默认边界。 */
export const DEFAULT_MAX_SYMBOLS = 2000;
export const DEFAULT_SIGNATURE_CHARS = 120;

/** 按文件名选引擎。 */
export function detectLanguage(fileName) {
  return JAVA_RE.test(String(fileName)) ? "java" : "generic";
}

// ─── Java 词法状态 ───
const NONE = 0;
const LINE_COMMENT = 1;
const BLOCK_COMMENT = 2;
const STRING = 3;
const CHAR = 4;
const TEXT_BLOCK = 5;

/** 帧是否为「允许声明成员」的上下文。 */
function memberContext(kind) {
  return kind === "class" || kind === "interface" || kind === "enum" || kind === "record" || kind === "anon";
}

function isIdentStart(cc) {
  return (cc >= 97 && cc <= 122) || (cc >= 65 && cc <= 90) || cc === 95 || cc === 36;
}

function isIdentWord(w) {
  return /^[A-Za-z_$][\w$]*$/.test(w);
}

/** 头缓冲区是否含平衡的 ( ... ) —— 判断是否为带参数表的声明。 */
function candHasBalancedParen(words) {
	let depth = 0;
	let seen = false;
	for (const w of words) {
		for (let k = 0; k < w.length; k++) {
			const ch = w[k];
			if (ch === "(") {
				depth++;
				seen = true;
			} else if (ch === ")") {
				depth--;
			}
		}
	}
	return seen && depth === 0;
}

/** 取紧邻第一个 ( 之前的词作方法名，比"最后一个貌似标识符"更准。 */
function nameBeforeParen(words) {
	let i = 0;
	for (; i < words.length; i++) {
		if (words[i].includes("(")) break;
	}
	if (i === 0) return null;
	return words[i - 1];
}

/** 从词表里取最后一个「像标识符」的词作为符号名。 */
function nameFromWords(words) {
  for (let k = words.length - 1; k >= 0; k--) {
    const w = words[k];
    if (isIdentWord(w) && !/^(class|interface|enum|record|if|for|while|do|switch|try|catch|finally|synchronized|else|return|new|public|private|protected|static|final|void|abstract|default|extends|implements|this|super)$/.test(w)) {
      return w;
    }
  }
  return null;
}

/**
 * 单遍扫描 Java 源码，返回符号数组。
 * @param {string} source
 * @param {{maxSymbols?:number, signatureChars?:number}} [opts]
 */
export function scanJava(source, opts = {}) {
  const maxSymbols = opts.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const sigChars = opts.signatureChars ?? DEFAULT_SIGNATURE_CHARS;
  const symbols = [];
  let truncated = false;

  const n = source.length;
  let line = 1;

  let mode = NONE;
  let genDepth = 0; // 泛型 < 的嵌套深度（>>> 视为多个 >> 逐个减）

  /** 帧：{kind, name, namePath, sym} —— sym 为该帧对应的符号（用来回填 line_end）。 */
  const frames = [];
  const topKind = () => (frames.length ? frames[frames.length - 1].kind : null);
  const topPath = () => (frames.length ? frames[frames.length - 1].namePath : []);

  /** 候选头缓冲区（判断"声明"）。 */
  let candWords = [];
  let candLine = 0;
  let candTypeKw = null; // class/interface/enum/record
  let candName = null; // 紧随类型关键字的类型名
  let candHasString = false;

  const clearCand = () => {
    candWords = [];
    candLine = 0;
    candTypeKw = null;
    candName = null;
    candHasString = false;
  };
  const pushWord = (w) => {
    if (candHasString) return;
    if (candWords.length === 0) candLine = line;
    candWords.push(w);
  };
  const sigFrom = (words) => {
    const s = words.join(" ").replace(/\s+/g, " ").trim();
    return s.length > sigChars ? `${s.slice(0, sigChars)}…` : s;
  };
  const namePathOf = (path) => (path.length ? path.join("/") : "");

  /** 发射一个符号并在当前帧上回填 line_end。 */
  const pushSym = (sym) => {
    sym.line_end = line;
    symbols.push(sym);
    return sym;
  };
  const pushFrame = (kind, name, sym) => {
    // 帧名沿用符号名；namePath 以符号名为叶子
    const namePath = name ? (topPath().length ? [...topPath(), name] : [name]) : topPath();
    frames.push({ kind, name, namePath, sym });
  };

  /** 方法/构造方法符号（头已平衡参数表，属成员上下文）。 */
  const emitMethod = (openLine) => {
    const words = candWords;
    const l0 = candLine || openLine;
    const name = nameBeforeParen(words) ?? nameFromWords(words) ?? "anon";
    const path = topPath();
    const sym = {
      kind: "method",
      name,
      name_path: namePathOf([...path, name]),
      signature: sigFrom(words),
      depth: path.length,
      line_start: l0,
      line_end: openLine,
    };
    clearCand();
    return pushSym(sym);
  };

  /** 字段/常量（分号结尾，成员上下文）。 */
  const emitField = () => {
    const words = candWords;
    clearCand();
    if (!words.length) return null;
    const name = nameFromWords(words);
    if (!name) return null;
    const path = topPath();
    return pushSym({
      kind: "field",
      name,
      name_path: namePathOf([...path, name]),
      signature: sigFrom(words),
      depth: path.length,
      line_start: candLine || line,
      line_end: line,
    });
  };

  let i = 0;
  while (i < n) {
    if (symbols.length >= maxSymbols) {
      truncated = true;
      break;
    }
    const c = source.charCodeAt(i);

    // ── 词法模式内消费 ──
    if (mode === LINE_COMMENT) {
      if (c === 10) {
        mode = NONE;
        i++;
        line++;
      } else i++;
      continue;
    }
    if (mode === BLOCK_COMMENT) {
      if (c === 42 && source.charCodeAt(i + 1) === 47) {
        mode = NONE;
        i += 2;
      } else {
        if (c === 10) line++;
        i++;
      }
      continue;
    }
    if (mode === STRING) {
      if (c === 92) {
        i += 2;
      } else {
        if (c === 34) {
          mode = NONE;
          clearCand(); // 声明头里出现字符串 => 整头作废，避免误判
        }
        if (c === 10) line++;
        i++;
      }
      continue;
    }
    if (mode === CHAR) {
      if (c === 92) {
        i += 2;
      } else {
        if (c === 39) mode = NONE;
        if (c === 10) line++;
        i++;
      }
      continue;
    }
    if (mode === TEXT_BLOCK) {
      if (c === 34 && source.charCodeAt(i + 1) === 34 && source.charCodeAt(i + 2) === 34) {
        mode = NONE;
        i += 3;
      } else {
        if (c === 10) line++;
        i++;
      }
      continue;
    }

    // ── 普通代码的词法入口 ──
    if (c === 47 && source.charCodeAt(i + 1) === 47) {
      mode = LINE_COMMENT;
      i += 2;
      continue;
    }
    if (c === 47 && source.charCodeAt(i + 1) === 42) {
      mode = BLOCK_COMMENT;
      i += 2;
      continue;
    }
    if (c === 34) {
      if (source.charCodeAt(i + 1) === 34 && source.charCodeAt(i + 2) === 34) {
        mode = TEXT_BLOCK;
        i += 3;
      } else {
        mode = STRING;
        i++;
      }
      continue;
    }
    if (c === 39) {
      mode = CHAR;
      i++;
      continue;
    }
    if (c === 64) {
      // 注解：跳过整个 @Name(…) —— 参数里可能含字符串字面量，绝不能清空声明头。
      i++;
      while (i < n && /[A-Za-z0-9_.$]/.test(source[i])) i++;
      while (i < n && /\s/.test(source[i])) i++;
      if (i < n && source[i] === "(") {
        let depth = 1;
        i++;
        while (i < n && depth > 0) {
          const ac = source.charCodeAt(i);
          if (ac === 34) {
            // 跳过字符串字面量（含转义）；不能吞掉后续的 )。
            i++;
            while (i < n) {
              const sc = source[i];
              if (sc === "\\") {
                i += 2;
                continue;
              }
              if (sc === '"') {
                i++;
                break;
              }
              if (sc === "\n") line++;
              i++;
            }
            continue; // 不再走末尾 i++，避免越过 ) 位置
          }
          if (ac === 40) depth++;
          else if (ac === 41) depth--;
          else if (ac === 10) line++;
          i++;
        }
      }
      continue;
    }
    if (c === 60) {
      genDepth++;
      i++;
      continue;
    }
    if (c === 62) {
      if (genDepth > 0) genDepth--;
      i++;
      continue;
    }
    if (genDepth > 0) {
      // 泛型参数表不会含 { ; )。遇到这些（多半是表达式里的比较 < ）退出泛型态，
      // 否则整段方法体会被误当作泛型内容吞掉（如 for (i=0; i<3; ...)）。
      if (c === 123 || c === 59 || c === 41) {
        genDepth = 0;
      } else {
        if (c === 10) line++;
        i++;
        continue;
      }
    }

    // ── 结构字符 ──
    if (c === 10) {
      line++;
      i++;
      continue;
    }
    if (c === 123) {
      // {
      const isTypeOpen = candTypeKw && TYPE_KINDS.has(candTypeKw) && candName;
      const isMemberCtx = memberContext(topKind());

      if (isTypeOpen) {
        // 类型声明：class/interface/enum/record X {
        const t = candTypeKw;
        const name = candName;
        const sym = pushSym({
          kind: t,
          name,
          name_path: namePathOf([...topPath(), name]),
          signature: sigFrom(candWords),
          depth: topPath().length,
          line_start: candLine || line,
          line_end: line,
        });
        clearCand();
        pushFrame(t, name, sym);
        i++;
        continue;
      }

      if (isMemberCtx && candHasBalancedParen(candWords)) {
        // 方法/构造器：成员上下文 + 平衡参数表
        const sym = emitMethod(line);
        pushFrame("body", null, sym);
        i++;
        continue;
      }

      if (topKind() === "enum" && candWords.length && isIdentWord(candWords[candWords.length - 1])) {
        // 枚举常量带匿名体：B { extra(){} }
        const name = candWords[candWords.length - 1];
        const sym = pushSym({
          kind: "constant",
          name,
          name_path: namePathOf([...topPath(), name]),
          signature: sigFrom(candWords),
          depth: topPath().length,
          line_start: candLine || line,
          line_end: line,
        });
        clearCand();
        pushFrame("anon", name, sym);
        i++;
        continue;
      }

      // 其余一律 body：控制流/lambda/数组初始化/static{} 等
      pushFrame("body", null, null);
      clearCand();
      i++;
      continue;
    }

    if (c === 125) {
      // }：弹帧，回填宿主符号 line_end
      const closing = frames.pop();
      if (closing?.sym) closing.sym.line_end = line;
      clearCand();
      i++;
      continue;
    }

    if (c === 59) {
      // 分号：成员上下文 + 头非空 => 字段 或 接口抽象方法（带平衡参数表）。
      if (memberContext(topKind()) && candHasString === false && candWords.length) {
        if (candHasBalancedParen(candWords)) emitMethod(line);
        else emitField();
      } else {
        clearCand();
      }
      i++;
      continue;
    }

    if (c === 40) {
      pushWord("(");
      i++;
      continue;
    }
    if (c === 41) {
      pushWord(")");
      i++;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++;
      const word = source.slice(i, j);
      i = j;
      if (TYPE_KINDS.has(word)) {
        candTypeKw = word;
        pushWord(word);
        continue;
      }
      if (candTypeKw && !candName && word !== "extends" && word !== "implements" && word !== "permits") {
        candName = word;
      }
      pushWord(word);
      continue;
    }

    // 其他字符（空白/运算符/逗号/点等）——不进头、不清头
    i++;
    continue;
  }

  return { symbols, truncated, engine: "java" };
}

// ─── 通用兜底引擎 ───

function truncateSig(s, sigChars) {
  return s.length > sigChars ? `${s.slice(0, sigChars)}…` : s;
}

/**
 * 通用兜底扫描：.py 用缩进级；其余用花括号级。粗粒度，一直可用。
 * @returns {{symbols:object[], truncated:boolean, engine:"generic"}}
 */
export function scanGeneric(fileName, source, opts = {}) {
  const maxSymbols = opts.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const sigChars = opts.signatureChars ?? DEFAULT_SIGNATURE_CHARS;
  const symbols = [];
  let truncated = false;

  if (PY_RE.test(String(fileName))) {
    const lines = source.split("\n");
    const stack = [];
    for (let k = 0; k < lines.length; k++) {
      if (symbols.length >= maxSymbols) {
        truncated = true;
        break;
      }
      const raw = lines[k];
      const indent = (raw.match(/^\s*/)?.[0] || "").length;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^(class|def)\s+([A-Za-z_$][\w$]*)/);
      if (!m) continue;
      while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
      const name = m[2];
      const path = stack.length ? [...stack[stack.length - 1].path, name] : [name];
      symbols.push({
        kind: m[1],
        name,
        name_path: path.join("/"),
        signature: truncateSig(trimmed, sigChars),
        depth: stack.length,
        line_start: k + 1,
        line_end: k + 1,
      });
      stack.push({ indent, path });
    }
    return { symbols, truncated, engine: "generic" };
  }

  // 花括号级兜底
  {
    const n = source.length;
    let line = 1;
    let depth = 0;
    const nameStack = [];
    for (let k = 0; k < n; k++) {
      if (symbols.length >= maxSymbols) {
        truncated = true;
        break;
      }
      const c = source.charCodeAt(k);
      if (c === 10) {
        line++;
        continue;
      }
      if (c === 34) {
        k++;
        while (k < n && source.charCodeAt(k) !== 34) k++;
        continue;
      }
      if (c === 123) {
        const chunk = source.slice(Math.max(0, k - 300), k);
        const m = chunk.match(/([A-Za-z_$][\w$]*)\s*(\([^)]*\))?\s*=?\s*$/);
        if (m && m[1]) {
          const name = m[1];
          const path = nameStack.length ? [...nameStack, name] : [name];
          symbols.push({
            kind: "block",
            name,
            name_path: path.join("/"),
            signature: truncateSig(m[1] + (m[2] ?? ""), sigChars),
            depth: nameStack.length,
            line_start: line,
            line_end: line,
          });
          nameStack.push(name);
        }
        depth++;
        continue;
      }
      if (c === 125) {
        depth--;
        if (depth < 0) depth = 0;
        if (nameStack.length) nameStack.pop();
        continue;
      }
    }
  }

  return { symbols, truncated, engine: "generic" };
}

/**
 * 统一入口：按文件名选引擎扫描。
 * @returns {{symbols:object[], truncated:boolean, engine:string, language:string}}
 */
// ─── 扫描结果 memocache（多 agent / 重复 outline 同一文件时命中，省重扫）───
const scanCache = new Map(); // key = `${file}::${fp}` -> packed scan
const scanCacheMax = 256; // 有界，先进先出，防长驻内存
const scanStats = { hits: 0, misses: 0, evictions: 0 };

/** 单遍 32-bit 滚动指纹：同一文件内容不变则指纹不变（省一次全量 hash 无关紧要）。 */
function sourceFingerprint(source) {
	let h = 0x811c9dc5;
	for (let i = 0; i < source.length; i++) {
		h ^= source.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36) + ":" + source.length;
}

/** 命中/未命中统计，供 doctor/bench 展示"缓存命中率"。 */
export function outlineCacheStats() {
	return { ...scanStats, hitRate: scanStats.hits + scanStats.misses > 0 ? scanStats.hits / (scanStats.hits + scanStats.misses) : 0 };
}

export function scanSymbols(fileName, source, opts = {}) {
	if (opts.cache === false) {
		const language = detectLanguage(fileName);
		const r = language === "java" ? scanJava(source, opts) : scanGeneric(fileName, source, opts);
		return { ...r, language };
	}
	const key = `${fileName}::${sourceFingerprint(source)}`;
	const hit = scanCache.get(key);
	if (hit) {
		scanStats.hits++;
		return hit;
	}
	scanStats.misses++;
	const language = detectLanguage(fileName);
	const r = language === "java" ? scanJava(source, opts) : scanGeneric(fileName, source, opts);
	const packed = { ...r, language };
	scanCache.set(key, packed);
	if (scanCache.size > scanCacheMax) {
		scanCache.delete(scanCache.keys().next().value);
		scanStats.evictions++;
	}
	return packed;
}

/**
 * 极简序列化（每符号一行 ASCII，默认不带签名 —— 仿 serena overview：kind + 位置 + name_path）：
 *   <kind> <depth> <line_start>-<line_end> <name_path>
 *   includeSignatures 时追加 <signature>（默认省掉，函数体/签名留在 Read 阶段按需取）。
 * @param {object[]} symbols
 * @param {string} [source] 仅 includeBody 时需要
 * @param {{query?:string, includeBody?:boolean, includeSignatures?:boolean}} [opts]
 */
export function serializeOutline(symbols, source, opts = {}) {
  const query = typeof opts.query === "string" ? opts.query.toLowerCase() : null;
  const includeBody = opts.includeBody === true;
  const showSig = opts.includeSignatures === true;
  const bodyLines = includeBody && typeof source === "string" ? source.split("\n") : null;
  const out = [];
  for (const s of symbols) {
    if (
      query &&
      !s.name_path.toLowerCase().includes(query) &&
      !String(s.name ?? "").toLowerCase().includes(query) &&
      !String(s.signature ?? "").toLowerCase().includes(query)
    ) {
      continue;
    }
    const sig = showSig && s.signature ? `  ${s.signature}` : "";
    out.push(`${s.kind} ${s.depth} ${s.line_start}-${s.line_end} ${s.name_path}${sig}`);
    if (includeBody && bodyLines && s.line_end >= s.line_start) {
      const slice = bodyLines
        .slice(s.line_start - 1, s.line_end)
        .map((ln) => `    ${ln}`)
        .join("\n");
      if (slice) out.push(slice);
    }
  }
  return out.join("\n");
}

/**
 * 支持度说明（供 doctor / 前端展示）。
 * @param {string} fileName
 */
export function supportedOutline(fileName) {
  return detectLanguage(fileName) === "java" ? "java (exact)" : "generic (rough)";
}

// ─── notable 过滤（吸取 serena GetNotableSymbolsTool 的经验）───

const NOTABLE_FIELD_DROP = /^(serialVersionUID|LOG|logger|slf4j|log)$/;
const OBJECT_BOILERPLATE = /^(toString|hashCode|equals|clone|compareTo|finalize)$/;
const ACCESSOR_RE = /^(get|set|is|has|with)[A-Z]/;

/** 方法签名里是否显式声明 private（决定是否算 API）。无修饰词按公开计。 */
function methodVisibility(sig) {
  return /\bprivate\b/.test(String(sig ?? "")) ? "private" : "public";
}

/**
 * 保留下游真正要注意的符号：类型 + 字段 + 非 private 的方法/构造器；
 * 丢掉 private helper 与单行 getter/setter 样板，让大型 *ServiceImpl outline 再省一截。
 * @param {object[]} symbols
 * @returns {object[]}
 */
export function filterNotable(symbols) {
  const out = [];
  for (const s of symbols) {
    if (s.kind === "method") {
      if (methodVisibility(s.signature) === "private") continue;
      if (OBJECT_BOILERPLATE.test(String(s.name ?? ""))) continue;
      // 单行 getter/setter/isXxx（{ return x; } 跨 1 行）→ 非决策点，丢
      const oneLiner = Number(s.line_end) - Number(s.line_start) <= 1;
      if (oneLiner && ACCESSOR_RE.test(String(s.name ?? ""))) continue;
      out.push(s);
      continue;
    }
    if (s.kind === "field") {
      if (NOTABLE_FIELD_DROP.test(String(s.name ?? ""))) continue;
      out.push(s);
      continue;
    }
    // class/interface/enum/record/constant/block 全保留
    out.push(s);
  }
  return out;
}