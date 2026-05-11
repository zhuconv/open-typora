// HTML feature — block-level `<div>…</div>` and inline `<kbd>x</kbd>`.
//
// Block model (matches Typora): an html_block is a textblock whose text is
// the raw HTML source. The inline scanner re-derives method-B marks over
// renderable patterns (`<img>`, `<a><img></a>`, `<kbd>x</kbd>`, …) and the
// decoration layer drops sanitized widgets at the right positions. The
// non-renderable source (`<br>`, `<p>`, `</p>`, plain text) stays visible
// in the block — same as Typora's "rendered images on top of the source
// you can still see and edit". No source/render toggle.
//
// Parser leans on markdown-it's native `html_block` rule (we opt into
// `html: true`) plus a custom paired-tag scanner that crosses blank lines
// for `<p>…\n\n…</p>` style content. Inline scan uses a regex over the
// textblock text (we deliberately do NOT enable md-it's html_inline so
// html-comment's existing path stays untouched).
//
// Note on `<!-- -->`: the parser routes comment-only html_blocks back to a
// paragraph carrying the verbatim text, so the existing html-comment mark
// still applies via the inline scanner — preserving its gray-italic UX.

import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

import { markConsumed, markExtRanges, type InlineSpan } from "../inline-parse.ts";
import { pairTags, tokenizeHtmlTags } from "../inline-html-tokenize.ts";
import { sanitize } from "../sanitize.ts";
import type { FeatureSpec, InlineFeatureSpec } from "./_types.ts";

// Architectural note: this feature does NOT extend the block parser.
// CommonMark §4.6 type-6/7 html_blocks end at a blank line — that's
// canonical and also how Typora behaves (each blank-line-separated
// chunk renders independently, alignment applies per-block). Earlier
// versions of this file added a paired-tag rule to keep `<p>…\n\n…</p>`
// together, but that made multi-paragraph HTML look like one giant
// centered block and diverged from Typora's "fragment + per-block
// alignment" model.
//
// (No NodeView needed: html_block is a plain styled textblock; PM renders
// it via toDOM, the inline scanner + decoration layer handle the
// rendered widgets, and CSS handles the visual chrome.)

// ─────────────────────────────────────────────────────────────────────────────
// Inline: method-B mark + widget render
// ─────────────────────────────────────────────────────────────────────────────
//
// Pipeline:
//   1. tokenizeHtmlTags() — CommonMark §6.6 grammar, position-aware.
//      Produces one token per `<tag>`, `</tag>`, `<self/>`, comment, etc.
//   2. pairTags() — stack-based balanced match. Returns `pair` (open+close)
//      or `void` (self-closing / HTML5 void element). Unmatched opens
//      and closes are dropped; their source stays visible.
//   3. Allowlist filter — only render tags we recognise as inline-rendered
//      content. Block-level tags (div / p / section) stay as visible
//      source even inside an html_block — Typora's "rendered images on
//      top of source you can still see" model.
//   4. Emit InlineSpan with the matched range. softInside hides the source
//      chars outside the cursor span; the widget renders sanitized HTML.
//
// Nesting (`<a><img></a>`, `<p><strong>x</strong></p>`): both inner and
// outer pairs are produced by pairTags. We sort by (start ASC, end DESC)
// so the outer pair claims its range first and the inner pair's blocked-
// check skips it — the outer widget renders the inner HTML literally
// (via DOMPurify in sanitize()).

// Inline-context tags we render as widgets. Picked to overlap GitHub's
// rendered-Markdown set for phrasing content + common "badge" patterns
// (`<a>`, `<span>` with attrs).
const INLINE_RENDER_TAGS = new Set([
  "a", "span",
  "b", "i", "strong", "em", "u", "s", "strike", "del", "ins",
  "kbd", "sub", "sup", "mark", "abbr", "cite", "q", "samp", "var",
  "small", "big", "tt", "ruby", "rt", "rp",
  "bdo", "bdi", "dfn", "time", "font",
]);

// Void elements that trigger inline widget rendering by themselves
// (no closer needed). `<br>` deliberately omitted — Typora keeps it as
// gray meta source rather than rendering an actual line break, and we
// match that. `<hr>` similarly stays as source.
const VOID_RENDER_TAGS = new Set(["img"]);

// Pure layout containers — when one appears as the FIRST token of an
// html_block we treat it as the block's wrapper: hide the opener chars
// and extract align/style attrs to apply to the rest of the block.
// Tags with semantic UI (details/summary, blockquote, table family) are
// omitted: they should stay visible in source view so the user sees
// they're authoring structured HTML.
const BLOCK_CHROME_TAGS = new Set([
  "p", "div", "section", "article", "aside",
  "header", "footer", "nav", "main",
  "figure", "figcaption",
  "center",
]);

// HTML entity references — `&name;`, `&#NN;`, `&#xHH;` (browsers also
// accept `&#XHH;` with uppercase X). Common in README HTML (`&nbsp;`
// separators, `&amp;` literals). We render the decoded character as a
// widget; the source stays editable.
const ENTITY_RE = /&(?:[a-zA-Z][a-zA-Z0-9]+|#\d+|#[xX][0-9a-fA-F]+);/g;

// Cheap extractor — pulls `align="center"` or `style="text-align:center"`
// out of the open tag. Loose attr matching is OK here: the tokenizer
// already validated the tag's grammar, so we're peeking inside known-
// good source. Falls back to null if neither attr is present.
function extractAlignment(openSource: string, tagLow: string): "center" | "left" | "right" | null {
  if (tagLow === "center") return "center";
  const alignM = /\balign\s*=\s*['"]?(center|left|right)['"]?/i.exec(openSource);
  if (alignM) return alignM[1]!.toLowerCase() as "center" | "left" | "right";
  const styleM = /\bstyle\s*=\s*"([^"]*)"|\bstyle\s*=\s*'([^']*)'/i.exec(openSource);
  if (styleM) {
    const style = (styleM[1] || styleM[2] || "").toLowerCase();
    const taM = /text-align\s*:\s*(center|left|right)/.exec(style);
    if (taM) return taM[1] as "center" | "left" | "right";
  }
  return null;
}

function emitWidget(
  text: string,
  consumed: Uint8Array,
  start: number,
  end: number,
  out: InlineSpan[],
): void {
  for (let i = start; i < end; i++) {
    if (consumed[i]) return;
  }
  markConsumed(consumed, start, end);
  const source = text.slice(start, end);
  out.push({
    type: "html_inline",
    from: start,
    to: end,
    openFrom: start,
    openTo: start,
    closeFrom: end,
    closeTo: end,
    attrs: { source },
    delimRanges: [{ from: start, to: end, softInside: true }],
    widgetDecorations: [
      { pos: end, when: "outside", kind: "html-inline-render", attrs: { source } },
    ],
  });
}

// Block-opener variant: when the very first non-whitespace token of an
// html_block is a block-chrome opening tag, treat it as the block's
// wrapper — hide its source chars. Alignment is applied at the block
// (div) level by the htmlBlockAlignPlugin below; doing it via an inline
// extraDecoration here doesn't work because PM widgets break out of
// inline ranges (badges inside `<p align="center">` end up unaligned).
//
// Doesn't try to pair with a closing tag — html_block fragments at
// blank lines per CommonMark, so the closer often lives in a different
// block and we'd never find it here. Matches Typora's per-block render
// of `<p align="center">…</p>` README headers.
function emitBlockOpener(
  consumed: Uint8Array,
  open: { tag: string; start: number; end: number; source: string },
  blockEnd: number,
  out: InlineSpan[],
): boolean {
  for (let i = open.start; i < open.end; i++) if (consumed[i]) return false;
  markConsumed(consumed, open.start, open.end);

  out.push({
    // Empty mark range — we only want the delim decoration, no
    // html_inline mark on the inner content (it stays free for nested
    // scanners).
    type: "html_inline",
    from: blockEnd, to: blockEnd,
    openFrom: blockEnd, openTo: blockEnd,
    closeFrom: blockEnd, closeTo: blockEnd,
    delimRanges: [{ from: open.start, to: open.end, softInside: true }],
  });
  return true;
}

// Gray-meta variant: every HTML tag that didn't trigger a widget or a
// block-opener treatment renders its source as `<span class="html-meta">`
// (light gray, monospace-ish). Mirrors Typora's UX for unrenderable
// inline HTML like `<br>` / `</p>` inside an html_block: the user sees
// the source as a hint that they're authoring HTML, without committing
// to a fake line break or a hidden phantom tag.
function emitGrayMeta(
  consumed: Uint8Array,
  tok: { start: number; end: number },
  out: InlineSpan[],
): void {
  for (let i = tok.start; i < tok.end; i++) if (consumed[i]) return;
  markConsumed(consumed, tok.start, tok.end);
  out.push({
    type: "html_inline",
    from: tok.end, to: tok.end,
    openFrom: tok.end, openTo: tok.end,
    closeFrom: tok.end, closeTo: tok.end,
    extraDecorations: [
      { from: tok.start, to: tok.end, nodeName: "span", attrs: { class: "html-meta" } },
    ],
  });
}

function emitEntities(text: string, consumed: Uint8Array, out: InlineSpan[]): void {
  ENTITY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTITY_RE.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    let blocked = false;
    for (let i = start; i < end; i++) if (consumed[i]) { blocked = true; break; }
    if (blocked) continue;
    markConsumed(consumed, start, end);
    const source = m[0];
    out.push({
      type: "html_inline",
      from: start, to: end,
      openFrom: start, openTo: start,
      closeFrom: end, closeTo: end,
      attrs: { source },
      delimRanges: [{ from: start, to: end, softInside: true }],
      widgetDecorations: [
        { pos: end, when: "outside", kind: "html-inline-render", attrs: { source } },
      ],
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Block alignment plugin — Decoration.node on html_block divs
// ─────────────────────────────────────────────────────────────────────────────
//
// Why a plugin (and not extraDecorations on the inline span):
// `Decoration.inline` wraps a range of text positions, but PM widgets
// (the rendered badge images, the file-input icons, etc.) live outside
// the inline range — they're attached at single positions via
// `Decoration.widget`. Wrapping the inner content of a block with an
// alignment span via inline decoration leaves the widgets unaligned,
// which is exactly what the `<p align="center">` README headers need
// most. Node-level decoration on the html_block div sidesteps the
// problem: the alignment class lives on the container and CSS does the
// rest.

const blockAlignKey = new PluginKey<DecorationSet>("html-block-align");

function computeBlockAlign(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "html_block") return false;
    const text = node.textContent;
    if (text.indexOf("<") < 0) return false;
    const tokens = tokenizeHtmlTags(text);
    const first = tokens.find((t) => t.kind === "open" || t.kind === "close");
    if (!first || first.kind !== "open") return false;
    if (!BLOCK_CHROME_TAGS.has(first.tag.toLowerCase())) return false;
    // Allow a leading HTML comment + whitespace before the opener
    // (common `<!-- generated --><p align="center">…</p>` pattern).
    const leadingStripped = text
      .slice(0, first.start)
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim();
    if (leadingStripped !== "") return false;
    const align = extractAlignment(first.source, first.tag.toLowerCase());
    if (!align) return false;
    decos.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: `html-align-${align}`,
      }),
    );
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export const htmlBlockAlignPlugin = new Plugin<DecorationSet>({
  key: blockAlignKey,
  state: {
    init: (_, state) => computeBlockAlign(state.doc),
    apply: (tr, prev) => (tr.docChanged ? computeBlockAlign(tr.doc) : prev),
  },
  props: {
    decorations(state) {
      return blockAlignKey.getState(state);
    },
  },
});

const inlineHtmlScan: InlineFeatureSpec["scan"] = (text, consumed, parentBlock) => {
  const out: InlineSpan[] = [];
  const isHtmlBlock = parentBlock?.type.name === "html_block";

  if (text.indexOf("<") >= 0) {
    const tokens = tokenizeHtmlTags(text);

    // Pass 1: emit widgets for renderable balanced pairs + void tags.
    // Outer-before-inner sort so outer wins against inner of same shape.
    const matches = pairTags(tokens);
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    for (const m of matches) {
      const tagLow = m.tag.toLowerCase();
      if (m.kind === "void") {
        if (VOID_RENDER_TAGS.has(tagLow)) emitWidget(text, consumed, m.start, m.end, out);
      } else if (INLINE_RENDER_TAGS.has(tagLow)) {
        emitWidget(text, consumed, m.start, m.end, out);
      }
    }

    // Pass 2 (html_block only): if the first STRUCTURAL token (skipping
    // comments / PI / declarations / CDATA) is a block-chrome opener,
    // hide its source chars. Alignment is applied separately by
    // htmlBlockAlignPlugin (Decoration.node on the html_block div) —
    // needed because inline decorations can't reach PM widgets like
    // the rendered badges inside.
    if (isHtmlBlock) {
      const first = tokens.find((t) => t.kind === "open" || t.kind === "close");
      if (first && first.kind === "open" && BLOCK_CHROME_TAGS.has(first.tag.toLowerCase())) {
        // Allow comments / whitespace to precede the opener — common
        // pattern: `<!-- generated --><p align="center">…</p>`.
        const leading = text.slice(0, first.start);
        const leadingStripped = leading.replace(/<!--[\s\S]*?-->/g, "").trim();
        if (leadingStripped === "") emitBlockOpener(consumed, first, text.length, out);
      }
    }

    // Pass 3: every remaining tag token gets the gray-meta decoration.
    // Runs in any textblock (including paragraphs) so an orphan `</p>`
    // that md-it routed out of html_block context still reads as HTML
    // chrome. Comments belong to the html-comment feature and skip.
    for (const t of tokens) {
      if (t.kind === "comment") continue;
      emitGrayMeta(consumed, t, out);
    }
  }

  if (text.indexOf("&") >= 0) emitEntities(text, consumed, out);
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// FeatureSpec
// ─────────────────────────────────────────────────────────────────────────────

const COMMENT_BLOCK_RE = /^<!--[\s\S]*-->\s*$/;

export const html: FeatureSpec = {
  name: "html",

  nodes: {
    html_block: {
      group: "block",
      // text*-with-marks: PM treats this as a textblock so the inline
      // scanner runs over its text; `marks: "_"` lets method-B marks
      // (image, html_inline, etc.) attach to the embedded HTML source.
      // `code: true` makes Enter insert `\n` (we want multi-line HTML
      // sources to stay one block, not split).
      content: "text*",
      code: true,
      marks: "_",
      defining: true,
      parseDOM: [
        { tag: "div[data-html-block]", preserveWhitespace: "full" },
      ],
      toDOM: () => ["div", { "data-html-block": "", class: "html-block" }, 0],
    },
  },

  marks: {
    html_inline: {
      inclusive: false,
      // No attrs — the source IS the doc text, so attrs would duplicate it
      // and risk drift. The widget reads source from a transient attrs bag
      // emitted by the inline scanner (see InlineSpan.attrs flow).
      parseDOM: [{ tag: "span[data-html-inline]" }],
      toDOM: () => ["span", { "data-html-inline": "" }, 0],
    },
  },

  mdItPlugins: [
    (md) => {
      // Enable markdown-it's built-in HTML parsing. html_block tokens flow
      // through our parser; html_inline tokens become literal text + the
      // inline scanner re-derives marks (method-B). CommonMark's standard
      // blank-line-terminates-html-block behavior is preserved — alignment
      // applies per-block, matching Typora's render.
      md.set({ html: true });
    },
  ],

  parserTokens: {
    html_block: (state, tok, schema) => {
      // Strip only the trailing newline md-it appends; preserve any
      // trailing whitespace inside the block source (it can be meaningful
      // for both round-trip and html-comment's inline UX).
      const content = tok.content.replace(/\n+$/, "");
      // Comment-only html_blocks → keep as a paragraph so the existing
      // html-comment mark (gray italic via inline scanner) keeps its UX.
      if (COMMENT_BLOCK_RE.test(content)) {
        state.openNode(schema.nodes.paragraph);
        state.addText(content);
        state.closeNode();
        return;
      }
      // md-it's html_block type-7 catches `<not a url>` and similar — text
      // that opens with `<` but doesn't actually parse as HTML the
      // sanitizer recognises. Validate via sanitize: if no tags survive,
      // route to a plain paragraph so the user just sees their typed text.
      const sanitized = sanitize(content);
      if (!/</.test(sanitized)) {
        state.openNode(schema.nodes.paragraph);
        state.addText(content);
        state.closeNode();
        return;
      }
      const textNodes = content ? [schema.text(content)] : [];
      state.push(schema.nodes.html_block.createChecked({}, textNodes));
    },
    // md-it emits html_inline as separate open/close tokens; we just emit
    // their content verbatim and let the inline scanner re-derive marks.
    html_inline: (state, tok) => {
      state.addText(tok.content);
    },
  },

  blockHandlers: {
    html_block: (state, node) => {
      state.write(node.textContent);
      state.closeBlock(node);
    },
  },

  markDelims: {
    html_inline: { open: "", close: "" },
  },

  plugins: () => [htmlBlockAlignPlugin],

  inline: {
    // After link (3) / math (4). HTML doesn't share delim chars with any
    // of them so ordering is for cleanliness more than necessity.
    priority: 5,
    scan: inlineHtmlScan,
    markNames: ["html_inline"],
    extRanges: (parent) => markExtRanges(parent, "html_inline", 0),
  },

  keymap: (schema) => ({
    // Inside an html_block on an empty trailing line → exit to block below.
    Enter: (state, dispatch) => {
      const sel = state.selection;
      if (!sel.empty) return false;
      const $from = sel.$from;
      if ($from.parent.type.name !== "html_block") return false;
      const text = $from.parent.textContent;
      if ($from.parentOffset !== text.length) return false;
      if (!(text === "" || text.endsWith("\n"))) return false;
      if (dispatch) {
        const tr = state.tr;
        const blockEnd = $from.after();
        if (text.endsWith("\n")) tr.delete(blockEnd - 2, blockEnd - 1);
        const newBlockEnd = text.endsWith("\n") ? blockEnd - 1 : blockEnd;
        if (newBlockEnd >= tr.doc.content.size) {
          const para = schema.nodes.paragraph.create();
          tr.insert(newBlockEnd, para);
        }
        tr.setSelection(TextSelection.create(tr.doc, newBlockEnd + 1));
        dispatch(tr);
      }
      return true;
    },

    ArrowDown: (state, dispatch) => {
      const sel = state.selection;
      if (!sel.empty) return false;
      const $from = sel.$from;
      if ($from.parent.type.name !== "html_block") return false;
      const tail = $from.parent.textContent.slice($from.parentOffset);
      if (tail.includes("\n")) return false;
      if (dispatch) {
        const tr = state.tr;
        const blockEnd = $from.after();
        if (blockEnd >= tr.doc.content.size) {
          const para = state.schema.nodes.paragraph.create();
          tr.insert(blockEnd, para);
        }
        tr.setSelection(TextSelection.create(tr.doc, blockEnd + 1));
        dispatch(tr);
      }
      return true;
    },

    Backspace: (state, dispatch) => {
      const sel = state.selection;
      if (!sel.empty) return false;
      const $from = sel.$from;
      if ($from.parent.type.name !== "html_block") return false;
      if ($from.parent.content.size > 0) return false;
      if (dispatch) {
        const pos = $from.before();
        const size = $from.parent.nodeSize;
        const tr = state.tr.delete(pos, pos + size);
        if (tr.doc.content.size === 0) {
          const p = schema.nodes.paragraph.createAndFill();
          if (p) tr.insert(0, p);
        }
        dispatch(tr);
      }
      return true;
    },
  }),
};
