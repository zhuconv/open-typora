import type { Node as PMNode } from "prosemirror-model";
import { EditorState, Plugin } from "prosemirror-state";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";

import { cursorRenderPlugin } from "./cursor-render.ts";
import { syntaxHintsPlugin } from "./decorations.ts";
import { collectKeymaps, collectPlugins } from "./features/index.ts";
import { markdownInputRules, spaceBreaksStoredMarks } from "./input-rules.ts";
import { normalizeInlinePlugin } from "./normalize.ts";
import { schema } from "./schema.ts";

// Click semantics on `<a>`:
//   plain click  → open href in a new tab (preventDefault on PM's caret move)
//   Cmd/Ctrl+click → fall through to PM, which positions the caret inside
//                    the link span for editing the text/href
// Trade-off vs Typora's stock behavior: we prioritise "links act like links"
// over "click positions caret", which suits Typora-web's WYSIWYG audience.
// Caret positioning is still reachable via Mod-click or arrow keys.
function openLinkOnClickPlugin(): Plugin {
  return new Plugin({
    props: {
      handleClick(_view, _pos, event) {
        const a = (event.target as Element | null)?.closest("a");
        if (!a) return false;
        const href = a.getAttribute("href");
        if (!href) return false;
        const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
        const mod = isMac ? event.metaKey : event.ctrlKey;
        if (mod) return false;
        event.preventDefault();
        window.open(href, "_blank", "noopener,noreferrer");
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
    openLinkOnClickPlugin(),
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
