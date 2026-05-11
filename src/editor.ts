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

// Open `<a>` on Cmd/Ctrl+click — Typora's stock behavior. Plain click
// stays as PM's caret placement so the link text remains editable
// without a modifier shortcut. The modifier check is fail-soft: if
// navigator.platform is empty (modern Chromium under UA-CH), accept
// either Meta or Ctrl as the navigation modifier.
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
    openLinkOnModClickPlugin(),
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
