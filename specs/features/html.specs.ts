import type { FeatureSpecs } from "../_types.ts";

// pretty contract for HTML:
//   - block (NodeView dom = <div class="html-block" data-html-block>):
//       active   → `<<<html\n<source-with-cursor>\nhtml>>>`
//       inactive → `<html-block source="<source>" />`
//   - inline (method-B mark over `<TAG>x</TAG>` literal in textblock text):
//       cursor outside → `<html-inline/>`
//       cursor inside  → the literal source chars become visible

function readCodeText(el: Element): string {
  const code = el.querySelector("code");
  if (!code) return "";
  let text = "";
  for (const child of Array.from(code.childNodes)) {
    if (child.nodeType === 3) {
      text += (child as Text).data;
    } else if (child.nodeType === 1) {
      const ce = child as Element;
      const list = ce.classList;
      const tag = ce.tagName.toLowerCase();
      if (tag === "span" && list.contains("play-caret")) text += "|";
      else if (tag === "span" && list.contains("selection-marker"))
        text += ce.textContent ?? "";
      else if (tag === "br" && list.contains("ProseMirror-trailingBreak")) {
        // skip placeholder
      } else text += ce.textContent ?? "";
    }
  }
  return text;
}

export const htmlSpecs: FeatureSpecs = {
  name: "html",
  renderCases: {
    div: (_children, el) => {
      if (!el.classList.contains("html-block")) return null;
      const active = el.classList.contains("hb-active");
      const source = readCodeText(el);
      return active
        ? `<<<html\n${source}\nhtml>>>`
        : `<html-block source=${JSON.stringify(source)} />`;
    },
    span: (_children, el) => {
      if (el.classList.contains("html-inline-render")) return "<html-inline/>";
      return null;
    },
  },
  cases: [
    // ──────────────────────────────────────────────────────────────
    // 1. Block-level <details> parses as html_block (cursor not in it).
    // ──────────────────────────────────────────────────────────────
    {
      id: "parse-details",
      label: "seed `<details>...</details>` with trailing paragraph",
      seed: "<details><summary>X</summary>body</details>\n\nafter",
      events: [],
      checkpoints: [
        {
          at: 0,
          expect:
            '<html-block source="<details><summary>X</summary>body</details>" />\nafter|',
        },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 2. `<not a url>` (md-it would call this html_block type 7) is
    //    routed back to a plain paragraph because sanitize() rejects it.
    // ──────────────────────────────────────────────────────────────
    {
      id: "garbage-stays-paragraph",
      label: "`<not a url>` doesn't survive sanitize → plain paragraph",
      seed: "<not a url> ",
      events: [],
      checkpoints: [
        { at: 0, expect: "<not a url> |" },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 3. Inline `<kbd>` parses as html_inline mark; widget when cursor out.
    // ──────────────────────────────────────────────────────────────
    {
      id: "inline-kbd",
      label: "seed `press <kbd>Ctrl</kbd> here` → inline widget outside cursor",
      seed: "press <kbd>Ctrl</kbd> here",
      events: ["<Home>"],
      checkpoints: [
        // Cursor at start → outside the html_inline span → widget renders.
        { at: 1, expect: "|press <html-inline/> here" },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 4. Block-level <details> with cursor inside → source visible.
    // ──────────────────────────────────────────────────────────────
    {
      id: "edit-mode-on-cursor-inside",
      label: "cursor inside html_block → source view active",
      seed: "<details>x</details>",
      events: [],
      checkpoints: [
        // setup() lands cursor at end-of-doc, which is inside the html_block.
        { at: 0, expect: "<<<html\n<details>x</details>|\nhtml>>>" },
      ],
    },
  ],
};
