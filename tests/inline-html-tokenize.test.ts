import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { pairTags, tokenizeHtmlTags } from "../src/inline-html-tokenize.ts";

describe("tokenizeHtmlTags", () => {
  test("plain text — no tokens", () => {
    expect(tokenizeHtmlTags("hello world")).toEqual([]);
  });

  test("open + close tag", () => {
    const toks = tokenizeHtmlTags("<kbd>x</kbd>");
    expect(toks).toEqual([
      { kind: "open", tag: "kbd", selfClosing: false, start: 0, end: 5, source: "<kbd>" },
      { kind: "close", tag: "kbd", start: 6, end: 12, source: "</kbd>" },
    ]);
  });

  test("self-closing tag", () => {
    const toks = tokenizeHtmlTags('<img src="x"/>');
    expect(toks).toEqual([
      { kind: "open", tag: "img", selfClosing: true, start: 0, end: 14, source: '<img src="x"/>' },
    ]);
  });

  test("attr with `>` inside double quotes", () => {
    const toks = tokenizeHtmlTags('<a title="a>b">x</a>');
    expect(toks).toHaveLength(2);
    expect(toks[0]).toMatchObject({ kind: "open", tag: "a" });
    expect(toks[0]!.source).toBe('<a title="a>b">');
    expect(toks[1]).toMatchObject({ kind: "close", tag: "a" });
  });

  test("attr with single quotes", () => {
    const toks = tokenizeHtmlTags("<a title='a>b'>x</a>");
    expect(toks).toHaveLength(2);
    expect(toks[0]!.source).toBe("<a title='a>b'>");
  });

  test("HTML comment is a separate token", () => {
    const toks = tokenizeHtmlTags("a<!-- c -->b");
    expect(toks).toEqual([
      { kind: "comment", start: 1, end: 11, source: "<!-- c -->" },
    ]);
  });

  test("multiple tags in one string", () => {
    const toks = tokenizeHtmlTags("<a><b></b></a>");
    expect(toks.map((t) => t.kind)).toEqual(["open", "open", "close", "close"]);
  });

  test("unmatched `<` doesn't produce a token", () => {
    // `<foo` alone (no `>`) is not a valid open tag per the grammar.
    expect(tokenizeHtmlTags("<foo")).toEqual([]);
  });
});

describe("pairTags", () => {
  test("simple pair", () => {
    const toks = tokenizeHtmlTags("<kbd>x</kbd>");
    const matches = pairTags(toks);
    expect(matches).toEqual([
      { kind: "pair", tag: "kbd", start: 0, end: 12, openEnd: 5, closeStart: 6 },
    ]);
  });

  test("void tag — self-closing", () => {
    const toks = tokenizeHtmlTags('<img src="x"/>');
    const matches = pairTags(toks);
    expect(matches).toEqual([
      { kind: "void", tag: "img", start: 0, end: 14 },
    ]);
  });

  test("void tag — bare HTML5 void element", () => {
    // `<br>` and `<img>` without `/` are still void per HTML5.
    const toks = tokenizeHtmlTags("a<br>b");
    const matches = pairTags(toks);
    expect(matches).toEqual([
      { kind: "void", tag: "br", start: 1, end: 5 },
    ]);
  });

  test("nested same-tag — both pairs returned, outer wider", () => {
    const toks = tokenizeHtmlTags("<span><span>x</span></span>");
    const matches = pairTags(toks);
    expect(matches).toHaveLength(2);
    // Inner closes first → emits before outer.
    expect(matches[0]).toMatchObject({ kind: "pair", tag: "span", start: 6 });
    expect(matches[1]).toMatchObject({ kind: "pair", tag: "span", start: 0 });
    // Outer fully contains inner.
    expect(matches[1]!.end).toBeGreaterThan(matches[0]!.end);
  });

  test("unmatched open is dropped (no match emitted)", () => {
    const toks = tokenizeHtmlTags("<span>foo");
    expect(pairTags(toks)).toEqual([]);
  });

  test("unmatched close is dropped", () => {
    const toks = tokenizeHtmlTags("foo</span>");
    expect(pairTags(toks)).toEqual([]);
  });

  test("case-insensitive matching", () => {
    const toks = tokenizeHtmlTags("<KBD>x</kbd>");
    const matches = pairTags(toks);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ kind: "pair", tag: "KBD" });
  });

  test("anchor wrapping image — outer + inner both emitted", () => {
    const toks = tokenizeHtmlTags('<a href="x"><img src="y"/></a>');
    const matches = pairTags(toks);
    expect(matches).toHaveLength(2);
    // void emits at token time, pair at close time — order:
    // [0] = void(img), [1] = pair(a)
    expect(matches[0]).toMatchObject({ kind: "void", tag: "img" });
    expect(matches[1]).toMatchObject({ kind: "pair", tag: "a" });
  });
});
