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

import type { RuleBlock } from "markdown-it/lib/parser_block.mjs";
import { TextSelection } from "prosemirror-state";

import { markConsumed, markExtRanges, type InlineSpan } from "../inline-parse.ts";
import { sanitize } from "../sanitize.ts";
import type { FeatureSpec, InlineFeatureSpec } from "./_types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Paired-tag block rule — `<p>…\n\n…</p>` stays one block
// ─────────────────────────────────────────────────────────────────────────────
//
// CommonMark `html_block` type 6 ends at a blank line, which fragments
// HTML like the Vditor README (centered `<p>` with embedded `<img>` /
// `<a>` separated by blank lines). For block-level paired tags we scan
// across blank lines until the opening tag is balanced by its closer.
// Naive count over the raw source — tag names buried inside attribute
// values would mis-balance the count, but the common cases (tags on their
// own lines, simple text between) round-trip cleanly.

const PAIRED_BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "aside",
  "header", "footer", "nav", "main",
  "figure", "figcaption",
  "details", "summary",
  "blockquote",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup",
  "ul", "ol", "li", "dl", "dd", "dt",
  "form", "fieldset",
  "pre",
]);

const htmlBlockPairedRule: RuleBlock = (state, startLine, endLine, silent) => {
  const bm = state.bMarks[startLine]! + state.tShift[startLine]!;
  const em = state.eMarks[startLine]!;
  if (state.tShift[startLine]! > 3) return false;
  const firstLine = state.src.slice(bm, em);
  const openMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)\b/.exec(firstLine);
  if (!openMatch) return false;
  const tag = openMatch[1]!.toLowerCase();
  if (!PAIRED_BLOCK_TAGS.has(tag)) return false;

  const openRe = new RegExp(`<${tag}\\b(?=[\\s/>])`, "gi");
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");

  let depth = 0;
  let closeLine = -1;
  for (let line = startLine; line <= endLine; line++) {
    const ls = state.bMarks[line]!;
    const le = state.eMarks[line]!;
    const text = state.src.slice(ls, le);
    const opens = (text.match(openRe) ?? []).length;
    const closes = (text.match(closeRe) ?? []).length;
    depth += opens - closes;
    if (depth <= 0) {
      closeLine = line;
      break;
    }
  }
  // Balanced close not found (or close came before any open) — let the
  // stock html_block rule handle the line.
  if (closeLine === -1) return false;
  if (depth < 0) return false;
  if (silent) return true;

  const contentStart = state.bMarks[startLine]!;
  const contentEnd = state.eMarks[closeLine]!;
  const content = state.src.slice(contentStart, contentEnd);

  const token = state.push("html_block", "div", 0);
  token.content = content;
  token.markup = "<html-block-paired>";
  token.block = true;
  token.map = [startLine, closeLine + 1];
  state.line = closeLine + 1;
  return true;
};

// (No NodeView needed: html_block is a plain styled textblock; PM renders
// it via toDOM, the inline scanner + decoration layer handle the
// rendered widgets, and CSS handles the visual chrome.)

// ─────────────────────────────────────────────────────────────────────────────
// Inline: method-B mark + widget render
// ─────────────────────────────────────────────────────────────────────────────
//
// Three pattern families get rendered as inline widgets (sanitised HTML
// dropped at the source position; method-B source-hidden-outside-cursor):
//
//   1. `<a …><img …></a>` — link-wrapped image (badges, click-targets).
//   2. `<img …>` standalone.
//   3. `<TAG …>…</TAG>` paired inline tag from a conservative allowlist
//      (kbd / sub / sup / mark / ins / u / abbr / cite / q / samp / var /
//      small / big / tt).
//
// Order: longer / more specific patterns scan first so they claim chars
// before broader patterns get to them. Non-rendering structural source
// (`<br>`, `<p>`, `</p>`, plain text) stays as visible text — matches
// Typora's "rendered images on top of source you can still see and edit"
// behavior in HTML blocks.

const INLINE_TAGS = [
  "kbd", "sub", "sup", "mark", "ins", "u", "abbr", "cite", "q",
  "samp", "var", "small", "big", "tt",
];

const INLINE_TAGS_RE = INLINE_TAGS.join("|");

const HTML_LINK_IMG_RE = /<a\b(?:[^>]*)?>\s*<img\b(?:[^>]*?)\s*\/?>\s*<\/a>/gi;
const HTML_IMG_RE = /<img\b(?:[^>]*?)\s*\/?>/gi;
const HTML_INLINE_PAIR_RE = new RegExp(
  `<(${INLINE_TAGS_RE})(?:\\s+[^>]*)?>([^<\\n]*)</\\1>`,
  "gi",
);

function emitWidgetSpan(text: string, consumed: Uint8Array, re: RegExp, out: InlineSpan[]): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const fullStart = m.index;
    const fullEnd = fullStart + m[0].length;
    let blocked = false;
    for (let i = fullStart; i < fullEnd; i++) {
      if (consumed[i]) { blocked = true; break; }
    }
    if (blocked) continue;
    markConsumed(consumed, fullStart, fullEnd);

    const source = m[0];
    out.push({
      type: "html_inline",
      from: fullStart,
      to: fullEnd,
      openFrom: fullStart,
      openTo: fullStart,
      closeFrom: fullEnd,
      closeTo: fullEnd,
      attrs: { source },
      delimRanges: [{ from: fullStart, to: fullEnd, softInside: true }],
      widgetDecorations: [
        { pos: fullEnd, when: "outside", kind: "html-inline-render", attrs: { source } },
      ],
    });
  }
}

const inlineHtmlScan: InlineFeatureSpec["scan"] = (text, consumed) => {
  const out: InlineSpan[] = [];
  // Longest / most specific patterns first.
  emitWidgetSpan(text, consumed, HTML_LINK_IMG_RE, out);
  emitWidgetSpan(text, consumed, HTML_INLINE_PAIR_RE, out);
  emitWidgetSpan(text, consumed, HTML_IMG_RE, out);
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
      // inline scanner re-derives marks (method-B).
      md.set({ html: true });
      // Stock CommonMark splits a `<p>...\n\n...</p>` into multiple
      // html_blocks (type 6 ends at blank lines), which destroys layout-
      // ful multi-element HTML the user wrote as one logical block.
      // Pre-empt the stock rule with a paired-tag scanner that crosses
      // blank lines until the open tag is balanced. Falls back to the
      // stock rule for tags we don't track or unbalanced source.
      md.block.ruler.before("html_block", "html_block_paired", htmlBlockPairedRule, {
        alt: ["paragraph", "reference", "blockquote", "list"],
      });
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
