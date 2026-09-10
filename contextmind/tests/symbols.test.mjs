/**
 * symbols.mjs — 符号级扫描器单元测试（覆盖词法陷阱与结构判别）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectLanguage, scanSymbols, serializeOutline } from "../lib/symbols.mjs";

/** 扫描并返回 name -> symbol 映射。 */
function scan(src, name = "Foo.java") {
	const r = scanSymbols(name, src);
	assert.equal(r.truncated, false);
	return r.symbols;
}

function names(symbols) {
	return symbols.map((s) => s.name_path);
}

describe("detectLanguage", () => {
	it("routes .java to java, others to generic", () => {
		assert.equal(detectLanguage("A.java"), "java");
		assert.equal(detectLanguage("a/b/C.java"), "java");
		assert.equal(detectLanguage("m.py"), "generic");
		assert.equal(detectLanguage("s.ts"), "generic");
		assert.equal(detectLanguage("x"), "generic");
	});
});

describe("lexical safety (no false symbols from literals/comments)", () => {
	it("string literal with keywords/braces is not parsed", () => {
		const s = 'public class A { String s = "class Foo { }"; void go(){} }';
		const syms = scan(s);
		assert.deepEqual(names(syms), ["A", "A/go"]);
	});

	it("char literal braces are ignored (no false brace frame, fields intact)", () => {
		// '{' and '\'' inside char literals must not open a structural brace frame;
		// go stays at A/go (not nested deeper) and no phantom symbols leak.
		const s = "public class A { char c = '{'; char q = '\\''; void go(){} }";
		const syms = scan(s);
		assert.deepEqual(names(syms), ["A", "A/c", "A/q", "A/go"]);
	});

	it("line comment containing code is ignored", () => {
		const s = "public class A { // class Fake { void x(){} }\n void go(){} }";
		const syms = scan(s);
		assert.deepEqual(names(syms), ["A", "A/go"]);
	});

	it("block comment ignored", () => {
		const s = "public class A { /* if (x) {} */ void go(){} }";
		const syms = scan(s);
		assert.deepEqual(names(syms), ["A", "A/go"]);
	});

	it("text block is skipped, nested lookalikes ignored", () => {
		const s =
			'public class A { void go(){ String t = """\n' +
			'class X { void y(){} }\n' +
			'"""; }}';
		const syms = scan(s);
		assert.deepEqual(names(syms), ["A", "A/go"]);
	});

	it("unterminated comment/text block consumes to EOF without throwing", () => {
		assert.doesNotThrow(() => scan("public class A { void go(){ /* never closed"));
		assert.doesNotThrow(() => scan('public class A { String t = """ never closed'));
	});
});

describe("generics", () => {
	it("generic class is one symbol, braces inside not misread", () => {
		const s = "public class Box<T extends Comparable<T>> { T value; void set(T v){} }";
		const syms = scan(s);
		assert.deepEqual(names(syms), ["Box", "Box/value", "Box/set"]);
	});

	it("generic method is emitted once", () => {
		const s = "public class A { public <T> T convert(Class<T> c, Object o){ return c.cast(o); } }";
		const syms = scan(s);
		assert.deepEqual(names(syms), ["A", "A/convert"]);
	});

	it("comparison < in expression does not swallow method body", () => {
		const s = "public class A { int sum(){ int t=0; for (int i=0; i<3; i++){ t+=i; } return t; } void after(){} }";
		const syms = scan(s);
		assert.deepEqual(names(syms), ["A", "A/sum", "A/after"]);
	});
});

describe("structure", () => {
	it("nested classes produce name_path", () => {
		const s = "public class A { public class B { void m(){} } }";
		const syms = scan(s);
		assert.deepEqual(names(syms), ["A", "A/B", "A/B/m"]);
	});

	it("anonymous class member is caught", () => {
		const s = "public class A { Runnable r() { return new Runnable(){ void run(){} }; } }";
		const syms = scan(s);
		assert.ok(names(syms).includes("A/r"));
	});

	it("record is captured with its kind", () => {
		const s = "public record Point(int x, int y){ int manhattan(){ return 0; } }";
		const syms = scan(s);
		const rec = syms.find((x) => x.kind === "record");
		assert.ok(rec, "record symbol present");
		assert.equal(rec.name, "Point");
		assert.ok(names(syms).includes("Point/manhattan"));
	});

	it("interface abstract (;) vs default ({}) methods", () => {
		const s = "public interface A { void go(); default void d(){ } }";
		const syms = scan(s);
		assert.deepEqual(names(syms), ["A", "A/go", "A/d"]);
	});

	it("fields vs for-loop control block", () => {
		const s = "public class A { private int count; void m(){ for (int i=0;i<1;i++){} } }";
		const syms = scan(s);
		assert.deepEqual(names(syms), ["A", "A/count", "A/m"]);
	});

	it("annotations with string args do not break the header", () => {
		const s =
			'public interface A { List<Order> selectByUser(@Param("userId") Long userId, @Param("status") String status); }';
		const syms = scan(s);
		assert.deepEqual(names(syms), ["A", "A/selectByUser"]);
	});

	it("enum constants with anonymous bodies", () => {
		const s = "public enum S { A, B { int extra(){ return 1; } }, C; int base(){ return 0; } }";
		const syms = scan(s);
		assert.ok(names(syms).includes("S"));
		assert.ok(names(syms).includes("S/B/extra"), "anon-body method captured");
		assert.ok(names(syms).includes("S/base"));
	});

	it("mismatched braces return partial outline, no throw", () => {
		assert.doesNotThrow(() => scan("public class A { void m(){ if (x) { }"));
	});
});

describe("bounds", () => {
	it("maxSymbols caps and sets truncated", () => {
		const src = "public class A {\n" + "  void m(){}\n".repeat(50) + "}";
		const r = scanSymbols("A.java", src, { maxSymbols: 10 });
		assert.equal(r.truncated, true);
		assert.ok(r.symbols.length <= 10);
	});
});

describe("serializeOutline", () => {
	it("default omits body; includeBody appends indented slices", () => {
		const src = "public class A {\n  void go(){\n    return;\n  }\n}\n";
		const syms = scanSymbols("A.java", src).symbols;
		const plain = serializeOutline(syms);
		assert.ok(!plain.includes("return"));
		const withBody = serializeOutline(syms, src, { includeBody: true });
		assert.ok(withBody.includes("return"));
	});

	it("query filters by name_path", () => {
		const syms = scan('public class A { void go(){ void stop(){} } void xyz(){} }').filter(
			(s) => s.kind !== "class",
		);
		const out = serializeOutline(syms, undefined, { query: "go" });
		assert.ok(out.includes("A/go"));
		assert.ok(!out.includes("xyz"));
	});
});