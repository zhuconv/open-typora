// HTML feature — block-level `<div>…</div>` style + inline `<kbd>x</kbd>`.
//
// Block: code-shaped node (`text*`, code: true) with a NodeView that toggles
// between source view (cursor inside, raw HTML editable) and a sanitized
// render via DOMPurify+GFM allowlist (cursor outside). Parser leans on
// markdown-it's native `html_block` rule — we just opt into `html: true`.
//
// Inline: method-B mark wrapping `<TAG>…</TAG>` literal source in the doc
// text; widget decoration renders the sanitized HTML inline outside cursor,
// source visible inside (image.ts pattern). Inline scan uses a regex over
// the textblock text (we deliberately do NOT enable md-it's html_inline so
// html-comment's existing path stays untouched).
//
// Note on `<!-- -->`: the parser routes comment-only html_blocks back to a
// paragraph carrying the verbatim text, so the existing html-comment mark
// still applies via the inline scanner — preserving its gray-italic UX.

import type { RuleBlock } from "markdown-it/lib/parser_block.mjs";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, TextSelection } from "prosemirror-state";
import {
  Decoration,
  DecorationSet,
  type EditorView,
  type NodeView,
} from "prosemirror-view";

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

// ─────────────────────────────────────────────────────────────────────────────
// Block: html_block node + NodeView
// ─────────────────────────────────────────────────────────────────────────────

class HtmlBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private renderEl: HTMLElement;
  private view: EditorView;
  private getPos: () => number | undefined;

  constructor(
    node: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
    decorations: readonly Decoration[] = [],
  ) {
    this.view = view;
    this.getPos = getPos;

    const outer = document.createElement("div");
    outer.className = "html-block";
    outer.setAttribute("data-html-block", "");

    const pre = document.createElement("pre");
    pre.className = "html-source";
    const code = document.createElement("code");
    pre.appendChild(code);

    const render = document.createElement("div");
    render.className = "html-render";
    render.setAttribute("contenteditable", "false");

    outer.appendChild(pre);
    outer.appendChild(render);

    this.dom = outer;
    this.contentDOM = code;
    this.renderEl = render;

    this.refreshRender(node.textContent);
    this.applyDecorations(decorations);
    render.addEventListener("mousedown", this.onRenderMouseDown);
  }

  private onRenderMouseDown = (e: MouseEvent): void => {
    e.preventDefault();
    const pos = this.getPos();
    if (pos == null) return;
    const node = this.view.state.doc.nodeAt(pos);
    if (!node) return;
    const inside = pos + node.nodeSize - 1;
    const tr = this.view.state.tr.setSelection(
      TextSelection.create(this.view.state.doc, inside),
    );
    this.view.dispatch(tr);
    this.view.focus();
  };

  private refreshRender(source: string): void {
    if (!source.trim()) {
      this.renderEl.innerHTML = "";
      this.renderEl.classList.add("html-empty");
      this.renderEl.textContent = "HTML block — click to edit";
      return;
    }
    this.renderEl.classList.remove("html-empty");
    this.renderEl.innerHTML = sanitize(source);
  }

  private applyDecorations(decorations: readonly Decoration[]): void {
    let active = false;
    for (const d of decorations) {
      const spec = (d as unknown as { spec?: { hbActive?: boolean } }).spec;
      if (spec?.hbActive) active = true;
    }
    this.dom.classList.toggle("hb-active", active);
  }

  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (node.type.name !== "html_block") return false;
    this.refreshRender(node.textContent);
    this.applyDecorations(decorations);
    return true;
  }

  destroy(): void {
    this.renderEl.removeEventListener("mousedown", this.onRenderMouseDown);
  }
}

function htmlBlockChromePlugin(): Plugin {
  return new Plugin({
    props: {
      nodeViews: {
        html_block: (node, view, getPos, decorations) =>
          new HtmlBlockView(node, view, getPos, decorations as readonly Decoration[]),
      },
      decorations(state) {
        const sel = state.selection;
        if (!sel.empty) return null;
        const $from = sel.$from;
        for (let d = $from.depth; d >= 0; d--) {
          const n = $from.node(d);
          if (n.type.name === "html_block") {
            const pos = $from.before(d);
            return DecorationSet.create(state.doc, [
              Decoration.node(pos, pos + n.nodeSize, { class: "hb-active" }, { hbActive: true }),
            ]);
          }
        }
        return null;
      },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline: method-B mark + widget render
// ─────────────────────────────────────────────────────────────────────────────
//
// Allowed inline tags — a conservative subset of GFM that's plausibly inline.
// `<br>`/`<hr>`/`<img>` are not here because the editor already represents
// them as their own nodes (hard_break / horizontal_rule / image). `<a>` is
// excluded because the markdown link syntax + parser owns that semantic.

const INLINE_TAGS = [
  "kbd", "sub", "sup", "mark", "ins", "u", "abbr", "cite", "q",
  "samp", "var", "small", "big", "tt",
];

const INLINE_TAGS_RE = INLINE_TAGS.join("|");

// Match a closed pair `<TAG attrs?>content</TAG>` (case-insensitive on tag).
// Content cannot contain `<` (so nested tags aren't recognised in the pilot;
// good-enough heuristic for the common cases).
const HTML_INLINE_RE = new RegExp(
  `<(${INLINE_TAGS_RE})(?:\\s+[^>]*)?>([^<\\n]*)</\\1>`,
  "gi",
);

const inlineHtmlScan: InlineFeatureSpec["scan"] = (text, consumed) => {
  const out: InlineSpan[] = [];
  HTML_INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HTML_INLINE_RE.exec(text))) {
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
      // Open/close ranges collapse to zero so normalize doesn't paint the
      // standard delim hint — the mark wraps the entire literal source.
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
      content: "text*",
      code: true,
      marks: "",
      defining: true,
      parseDOM: [
        { tag: "div[data-html-block]", preserveWhitespace: "full" },
      ],
      toDOM: () => ["div", { "data-html-block": "" }, 0],
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

  plugins: () => [htmlBlockChromePlugin()],

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
