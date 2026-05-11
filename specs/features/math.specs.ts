import type { FeatureSpecs } from "../_types.ts";

// pretty contract for math:
//   - block (NodeView dom = <div class="math-block" data-math-block>):
//       active   → $$\n<source-with-cursor>\n$$
//       inactive → <math-block latex="<source>" />   (KaTeX HTML hidden)
//   - inline (method-B mark over `$x$` literal text):
//       cursor outside → <math:LATEX/>   (widget renders KaTeX, source hidden)
//       cursor inside  → `$x$` chars are visible (delim chars + content)
//
// Pretty extracts the LaTeX from the NodeView's <code> contentDOM rather
// than from the rendered KaTeX HTML — the source is authoritative; the
// KaTeX output is visualisation noise.

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
        // skip PM's empty-textblock placeholder
      } else text += ce.textContent ?? "";
    }
  }
  return text;
}

export const mathSpecs: FeatureSpecs = {
  name: "math",
  renderCases: {
    div: (_children, el) => {
      if (!el.classList.contains("math-block")) return null;
      const active = el.classList.contains("mb-active");
      const source = readCodeText(el);
      return active
        ? `$$\n${source}\n$$`
        : `<math-block latex=${JSON.stringify(source)} />`;
    },
    span: (_children, el) => {
      // Inline KaTeX render widget — surface as a positional marker.
      // The widget DOM contains KaTeX-generated HTML; the assertion
      // contract is "math rendered here", not the KaTeX markup itself.
      if (el.classList.contains("math-inline-render")) return "<math-inline/>";
      return null;
    },
  },
  cases: [
    // ──────────────────────────────────────────────────────────────
    // 1. `$$` + Enter spawns an empty math_block; cursor inside.
    // ──────────────────────────────────────────────────────────────
    {
      id: "spawn-empty-block",
      label: "$$ + Enter → empty math block, cursor inside source",
      seed: "",
      events: ["$", "$", "<Enter>"],
      checkpoints: [
        { at: 2, expect: "$$|" },
        { at: 3, expect: "$$\n|\n$$" },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 2. Type LaTeX into the block, cursor stays inside.
    // ──────────────────────────────────────────────────────────────
    {
      id: "type-latex",
      label: "$$+Enter then E=mc^2 → source visible while editing",
      seed: "",
      events: ["$", "$", "<Enter>", "E", "=", "m", "c", "^", "2"],
      checkpoints: [
        { at: 3, expect: "$$\n|\n$$" },
        { at: 9, expect: "$$\nE=mc^2|\n$$" },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 3. Parse-from-seed: a $$...$$ block renders as inactive math.
    // ──────────────────────────────────────────────────────────────
    {
      id: "parse-block",
      label: "seed `$$\\nE=mc^2\\n$$\\n\\nbody` parses; math is inactive",
      seed: "$$\nE=mc^2\n$$\n\nbody",
      events: [],
      checkpoints: [
        // Cursor lands at end of `body` paragraph → math_block is inactive
        // → its rendered KaTeX preview shows, source hidden.
        { at: 0, expect: '<math-block latex="E=mc^2" />\nbody|' },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 4. Inline `$x$`: cursor outside → widget; cursor inside → source.
    // ──────────────────────────────────────────────────────────────
    {
      id: "inline-parse-outside",
      label: "seed `a $x$ b` with cursor at start → inline widget",
      seed: "a $x$ b",
      events: ["<Home>"],
      checkpoints: [
        // Cursor at position 1 (start of paragraph). Outside math span.
        { at: 1, expect: "|a <math-inline/> b" },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 5. Inline `$x$` round-trip: parses, then serializes back.
    // ──────────────────────────────────────────────────────────────
    {
      id: "inline-cursor-inside",
      label: "place cursor inside `$x$` → source `$x$` becomes visible",
      seed: "a $x$ b",
      events: ["<End>"],
      checkpoints: [
        // Cursor at end of paragraph — past the inline math. Outside.
        { at: 1, expect: "a <math-inline/> b|" },
      ],
    },
  ],
};
