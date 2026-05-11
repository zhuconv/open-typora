import { Slice, type Node as PMNode } from "prosemirror-model";
import { EditorState, Plugin } from "prosemirror-state";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";

import { cursorRenderPlugin } from "./cursor-render.ts";
import { syntaxHintsPlugin } from "./decorations.ts";
import { collectKeymaps, collectPlugins } from "./features/index.ts";
import { markdownInputRules, spaceBreaksStoredMarks } from "./input-rules.ts";
import { normalizeInlinePlugin } from "./normalize.ts";
import { parse } from "./parser.ts";
import { schema } from "./schema.ts";

// Pasted HTML — when the clipboard contains block-level HTML markup,
// route it through the markdown parser so the paired-tag rule + sanitize
// path produce a proper html_block. Without this PM's stock DOMParser
// converts `<p>...<img>...</p>` into an empty paragraph (the schema has
// no parseDOM rule for arbitrary `<img>` / `<a>` so they're dropped).
//
// Triggers only on text/html that opens with a known block-level tag.
// Inline-only HTML and plain text fall through to PM's default paste so
// rich-text copy from other apps still works as expected.
const BLOCK_HTML_RE = /^\s*<(p|div|details|summary|table|thead|tbody|tfoot|tr|td|th|caption|colgroup|section|article|aside|header|footer|nav|main|figure|figcaption|blockquote|ul|ol|li|dl|dd|dt|pre|form|fieldset|h[1-6])\b/i;

function htmlPastePlugin(): Plugin {
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const cd = event.clipboardData;
        if (!cd) return false;
        const text = cd.getData("text/plain") ?? "";
        const html = cd.getData("text/html") ?? "";
        const looksBlock = BLOCK_HTML_RE.test(text) || BLOCK_HTML_RE.test(html);
        if (!looksBlock) return false;
        // Prefer text/plain — it's the verbatim source the user typed
        // when authoring (preserves whitespace and lets our paired-tag
        // rule scan as intended). Fall back to text/html when the
        // clipboard only carried the rich form.
        const source = BLOCK_HTML_RE.test(text) ? text : extractBodyHtml(html);
        try {
          const doc = parse(source);
          if (doc.childCount === 0) return false;
          const slice = new Slice(doc.content, 0, 0);
          const tr = view.state.tr.replaceSelection(slice);
          view.dispatch(tr);
          return true;
        } catch {
          return false;
        }
      },
    },
  });
}

// text/html clipboard payloads from browsers wrap content in
// `<html><body>…</body></html>` plus stylesheet `<meta>` chrome. Strip
// that down to the body's inner HTML for the markdown parser.
function extractBodyHtml(html: string): string {
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return bodyMatch ? bodyMatch[1]! : html;
}

// Open `<a>` on Cmd/Ctrl+click — Typora's stock behavior. Plain click
// stays as PM's caret placement so the link text remains editable
// without a modifier shortcut.
//
// The single-argument `window.open(href)` form is what Vditor uses and
// what the user wants:
//   * Chrome/Edge treat it as a user-initiated new tab → foreground.
//   * Passing `"_blank"` as the second arg + ANY features string flips
//     Safari/Firefox into "popup window" mode (background tab).
//   * `.focus()` on the returned Window is silently ignored by modern
//     browsers — does not pull the tab forward.
//   * No `noopener` because we're not over-engineering security on
//     external links the user explicitly chose to navigate to.
function openLinkInNewTab(href: string): void {
  window.open(href);
}

function openLinkOnModClickPlugin(): Plugin {
  return new Plugin({
    props: {
      handleClick(_view, _pos, event) {
        if (!event.metaKey && !event.ctrlKey) return false;
        const a = (event.target as Element | null)?.closest("a");
        if (!a) return false;
        const href = a.getAttribute("href");
        if (!href) return false;
        event.preventDefault();
        openLinkInNewTab(href);
        return true;
      },
    },
  });
}

export function defaultPlugins(options: { cursorWidget?: boolean } = {}): Plugin[] {
  // cursorRenderPlugin paints a visible caret even when the view is not
  // focused — only useful for the replay harness (fakeView has no focus).
  // A real browser editor already draws its own caret, so a live editor
  // should pass `{ cursorWidget: false }`.
  const { cursorWidget = true } = options;
  const featureKeymap = collectKeymaps(schema);
  const plugins: Plugin[] = [
    history(),
    keymap({ "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo }),
    markdownInputRules(),
    spaceBreaksStoredMarks(),
    normalizeInlinePlugin(),
    // Feature-contributed plugins sit after normalize (so block-draft
    // watchers see the post-normalize doc) and before syntaxHints (so any
    // extra decorations merge into PM's decoration pipeline naturally).
    ...collectPlugins(schema),
    syntaxHintsPlugin(),
    openLinkOnModClickPlugin(),
    htmlPastePlugin(),
  ];
  if (cursorWidget) plugins.push(cursorRenderPlugin());
  // Feature keymap wins over baseKeymap — features that override Enter /
  // Backspace for block exits rely on this ordering.
  if (Object.keys(featureKeymap).length > 0) plugins.push(keymap(featureKeymap));
  plugins.push(keymap(baseKeymap));
  return plugins;
}

export function createState(doc: PMNode): EditorState {
  return EditorState.create({ schema, doc, plugins: defaultPlugins() });
}
