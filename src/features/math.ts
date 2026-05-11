// Math feature — block `$$\n…\n$$` and inline `$x$`.
//
// Block: code-shaped node (`text*`, code: true) with a NodeView that swaps
// between source view (cursor inside) and KaTeX render (cursor outside).
// Inline: method-B mark wrapping `$x$` literal source in the doc text;
// widget decoration renders KaTeX outside, source visible inside (the
// image.ts softInside pattern).
//
// KaTeX runs synchronously (renderToString → innerHTML), throwOnError:false
// returns an inline error span we surface as `.math-error`.

import katex from "katex";
import type MarkdownIt from "markdown-it";
import type { RuleBlock } from "markdown-it/lib/parser_block.mjs";
import type { RuleInline } from "markdown-it/lib/parser_inline.mjs";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, TextSelection } from "prosemirror-state";
import {
  Decoration,
  DecorationSet,
  type EditorView,
  type NodeView,
} from "prosemirror-view";

import { markConsumed, markExtRanges, type InlineSpan } from "../inline-parse.ts";
import type { FeatureSpec, InlineFeatureSpec } from "./_types.ts";

import "katex/dist/katex.min.css";

// ─────────────────────────────────────────────────────────────────────────────
// KaTeX helper
// ─────────────────────────────────────────────────────────────────────────────

function renderInto(target: HTMLElement, latex: string, displayMode: boolean): void {
  target.classList.remove("math-error");
  try {
    target.innerHTML = katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      output: "html",
    });
  } catch (e) {
    target.textContent = e instanceof Error ? e.message : String(e);
    target.classList.add("math-error");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Block: `$$\n…\n$$`
// ─────────────────────────────────────────────────────────────────────────────

const mathBlockRule: RuleBlock = (state, startLine, endLine, silent) => {
  const start = state.bMarks[startLine]! + state.tShift[startLine]!;
  const max = state.eMarks[startLine]!;
  if (state.tShift[startLine]! > 3) return false;
  if (max - start < 2) return false;
  if (state.src.charCodeAt(start) !== 0x24) return false;
  if (state.src.charCodeAt(start + 1) !== 0x24) return false;
  // After `$$`, only optional whitespace allowed on the opening line.
  if (max - start > 2 && /\S/.test(state.src.slice(start + 2, max))) return false;

  let closeLine = -1;
  for (let line = startLine + 1; line <= endLine; line++) {
    const bm = state.bMarks[line]! + state.tShift[line]!;
    const em = state.eMarks[line]!;
    if (em - bm < 2) continue;
    if (state.src.charCodeAt(bm) !== 0x24) continue;
    if (state.src.charCodeAt(bm + 1) !== 0x24) continue;
    if (em - bm > 2 && /\S/.test(state.src.slice(bm + 2, em))) continue;
    closeLine = line;
    break;
  }
  if (closeLine === -1) return false;
  if (silent) return true;

  const contentStart = state.bMarks[startLine + 1] ?? max;
  const contentEnd = state.bMarks[closeLine]!;
  const content = state.src.slice(contentStart, contentEnd).replace(/\n$/, "");

  const token = state.push("math_block", "div", 0);
  token.content = content;
  token.markup = "$$";
  token.block = true;
  token.map = [startLine, closeLine + 1];
  state.line = closeLine + 1;
  return true;
};

class MathBlockView implements NodeView {
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
    outer.className = "math-block";
    // Mirror toDOM's attribute so a copy-paste round-trip can re-parse the
    // NodeView DOM via parseDOM.
    outer.setAttribute("data-math-block", "");

    const pre = document.createElement("pre");
    pre.className = "math-source";
    const code = document.createElement("code");
    pre.appendChild(code);

    const render = document.createElement("div");
    render.className = "math-render";
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
    // Click the rendered preview → enter source mode (caret at end of body).
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

  private refreshRender(latex: string): void {
    if (!latex.trim()) {
      this.renderEl.innerHTML = "";
      this.renderEl.classList.add("math-empty");
      this.renderEl.textContent = "math block — click to edit";
      return;
    }
    this.renderEl.classList.remove("math-empty");
    renderInto(this.renderEl, latex, true);
  }

  private applyDecorations(decorations: readonly Decoration[]): void {
    let active = false;
    for (const d of decorations) {
      const spec = (d as unknown as { spec?: { mbActive?: boolean } }).spec;
      if (spec?.mbActive) active = true;
    }
    this.dom.classList.toggle("mb-active", active);
  }

  update(node: PMNode, decorations: readonly Decoration[]): boolean {
    if (node.type.name !== "math_block") return false;
    this.refreshRender(node.textContent);
    this.applyDecorations(decorations);
    return true;
  }

  destroy(): void {
    this.renderEl.removeEventListener("mousedown", this.onRenderMouseDown);
  }
}

function mathBlockChromePlugin(): Plugin {
  return new Plugin({
    props: {
      nodeViews: {
        math_block: (node, view, getPos, decorations) =>
          new MathBlockView(node, view, getPos, decorations as readonly Decoration[]),
      },
      decorations(state) {
        const sel = state.selection;
        if (!sel.empty) return null;
        const $from = sel.$from;
        for (let d = $from.depth; d >= 0; d--) {
          const n = $from.node(d);
          if (n.type.name === "math_block") {
            const pos = $from.before(d);
            return DecorationSet.create(state.doc, [
              Decoration.node(pos, pos + n.nodeSize, { class: "mb-active" }, { mbActive: true }),
            ]);
          }
        }
        return null;
      },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline: `$x$`
// ─────────────────────────────────────────────────────────────────────────────
//
// Conditions (Pandoc-ish):
//   - opening `$` not followed by whitespace or `$`
//   - closing `$` not preceded by whitespace, not followed by a digit
//   - content cannot span a newline

const MATH_INLINE_RE = /\$(?![\s$])([^$\n]*?)(?<!\s)\$(?!\d)/g;
const MATH_INLINE_FROM = /^\$(?![\s$])([^$\n]*?)(?<!\s)\$(?!\d)/;

const inlineMathScan: InlineFeatureSpec["scan"] = (text, consumed) => {
  const out: InlineSpan[] = [];
  MATH_INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATH_INLINE_RE.exec(text))) {
    const fullStart = m.index;
    const fullEnd = fullStart + m[0].length;
    // Refuse if we'd overlap a `$$` boundary (block-level delim).
    if (fullStart > 0 && text[fullStart - 1] === "$") continue;
    if (fullEnd < text.length && text[fullEnd] === "$") continue;
    let blocked = false;
    for (let i = fullStart; i < fullEnd; i++) {
      if (consumed[i]) { blocked = true; break; }
    }
    if (blocked) continue;

    markConsumed(consumed, fullStart, fullEnd);
    const latex = m[1] ?? "";
    const openFrom = fullStart;
    const openTo = fullStart + 1;
    const closeFrom = fullEnd - 1;
    const closeTo = fullEnd;

    out.push({
      type: "math_inline",
      from: openTo,
      to: closeFrom,
      openFrom,
      openTo,
      closeFrom,
      closeTo,
      attrs: { latex },
      // Source visible inside (plain), hidden outside; the widget renders
      // the KaTeX preview at closeTo when the cursor is elsewhere.
      delimRanges: [{ from: openFrom, to: closeTo, softInside: true }],
      widgetDecorations: [
        { pos: closeTo, when: "outside", kind: "math-inline-render", attrs: { latex } },
      ],
    });
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// FeatureSpec
// ─────────────────────────────────────────────────────────────────────────────

const mathInlineMdRule: RuleInline = (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x24) return false;
  const m = MATH_INLINE_FROM.exec(state.src.slice(state.pos));
  if (!m) return false;
  if (silent) return true;
  const token = state.push("math_inline", "", 0);
  token.markup = "$";
  token.content = m[1] ?? "";
  state.pos += m[0].length;
  return true;
};

function registerMdMath(md: MarkdownIt): void {
  md.block.ruler.before("fence", "math_block", mathBlockRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.inline.ruler.after("escape", "math_inline", mathInlineMdRule);
}

export const math: FeatureSpec = {
  name: "math",

  nodes: {
    math_block: {
      group: "block",
      content: "text*",
      code: true,
      marks: "",
      defining: true,
      parseDOM: [
        { tag: "div[data-math-block]", preserveWhitespace: "full" },
      ],
      toDOM: () => ["div", { "data-math-block": "" }, 0],
    },
  },

  marks: {
    math_inline: {
      inclusive: false,
      attrs: { latex: { default: "" } },
      parseDOM: [
        {
          tag: "span[data-math-inline]",
          getAttrs: (el) => ({
            latex: (el as HTMLElement).getAttribute("data-latex") ?? "",
          }),
        },
      ],
      toDOM: (mark) => [
        "span",
        {
          "data-math-inline": "",
          "data-latex": String(mark.attrs.latex ?? ""),
        },
        0,
      ],
    },
  },

  mdItPlugins: [registerMdMath],

  parserTokens: {
    math_block: (state, tok, schema) => {
      const content = tok.content;
      const textNodes = content ? [schema.text(content)] : [];
      state.push(schema.nodes.math_block.createChecked({}, textNodes));
    },
    // Method-B: emit literal `$x$` text with the math_inline mark over the
    // content. normalize will re-scan and confirm the mark on next tick.
    math_inline: (state, tok, schema) => {
      state.addText("$");
      state.openMark(schema.marks.math_inline.create({ latex: tok.content }));
      state.addText(tok.content);
      state.closeMarkType(schema.marks.math_inline);
      state.addText("$");
    },
  },

  blockHandlers: {
    math_block: (state, node) => {
      state.write("$$\n");
      const text = node.textContent;
      state.out += text;
      if (text && !text.endsWith("\n")) state.out += "\n";
      state.write("$$");
      state.closeBlock(node);
    },
  },

  markDelims: {
    math_inline: { open: "", close: "" },
  },

  inline: {
    // After link (3) so that `[a $x$ b](url)` lets the link claim its chrome
    // first, then math claims the inner `$x$`.
    priority: 4,
    scan: inlineMathScan,
    markNames: ["math_inline"],
    extRanges: (parent) => markExtRanges(parent, "math_inline", 1),
  },

  plugins: () => [mathBlockChromePlugin()],

  keymap: (schema) => ({
    Enter: (state, dispatch) => {
      const sel = state.selection;
      if (!sel.empty) return false;
      const $from = sel.$from;
      // Path A: `$$` paragraph + Enter → spawn empty math_block, caret inside.
      if ($from.parent.type.name === "paragraph" && $from.parent.textContent === "$$") {
        if (dispatch) {
          const mbType = schema.nodes.math_block;
          const pos = $from.before();
          const para = $from.parent;
          const mb = mbType.create();
          const tr = state.tr.replaceWith(pos, pos + para.nodeSize, mb);
          tr.setSelection(TextSelection.create(tr.doc, pos + 1));
          dispatch(tr);
        }
        return true;
      }
      // Path B: inside math_block on empty trailing line → exit to block below.
      if ($from.parent.type.name === "math_block") {
        const text = $from.parent.textContent;
        if (
          $from.parentOffset === text.length &&
          (text === "" || text.endsWith("\n"))
        ) {
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
        }
        return false;
      }
      return false;
    },

    ArrowDown: (state, dispatch) => {
      const sel = state.selection;
      if (!sel.empty) return false;
      const $from = sel.$from;
      if ($from.parent.type.name !== "math_block") return false;
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
      if ($from.parent.type.name !== "math_block") return false;
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
