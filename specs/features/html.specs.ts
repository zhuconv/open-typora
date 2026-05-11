import type { FeatureSpecs } from "../_types.ts";

// pretty contract for HTML:
//   - html_block (toDOM = <div class="html-block" data-html-block>):
//       walked as a textblock — text source IS visible (the source-hiding
//       comes from the inline scanner's softInside delim ranges, scoped to
//       each matched pattern). Wrap children in `<html-block>…</html-block>`.
//   - inline widget (method-B mark over a matched HTML pattern):
//       widget rendered when cursor outside → pretty emits `<html-inline/>`.
//       The matched source chars are wrapped in `.syntax-hidden` so they
//       contribute "" to pretty's output.

export const htmlSpecs: FeatureSpecs = {
  name: "html",
  renderCases: {
    div: (children, el) => {
      if (!el.classList.contains("html-block")) return null;
      return `<html-block>${children}</html-block>`;
    },
    span: (_children, el) => {
      if (el.classList.contains("html-inline-render")) return "<html-inline/>";
      // Gray-meta visual marker for unmatched HTML tag chrome
      // (`<br>`, `</p>`, lone openers). Distinct from `<g>` (syntax-hint)
      // so tests show the html-meta path is firing.
      if (el.classList.contains("html-meta"))
        return `<m>${el.textContent ?? ""}</m>`;
      return null;
    },
  },
  cases: [
    // ──────────────────────────────────────────────────────────────
    // 1. Block-level <details> stays as a single html_block with the
    //    raw source visible as gray-meta (no scanner match → no
    //    widgets; semantic tags rendered as html-meta source).
    // ──────────────────────────────────────────────────────────────
    {
      id: "parse-details",
      label: "seed `<details>...</details>` + trailing paragraph",
      seed: "<details><summary>X</summary>body</details>\n\nafter",
      events: [],
      checkpoints: [
        {
          at: 0,
          expect:
            "<html-block><m><details></m><m><summary></m>X<m></summary></m>body<m></details></m></html-block>\nafter|",
        },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 2. `<not a url>` (md-it html_block type 7) doesn't survive
    //    sanitize → routed back to a plain paragraph.
    // ──────────────────────────────────────────────────────────────
    {
      id: "garbage-stays-paragraph",
      label: "`<not a url>` doesn't survive sanitize → paragraph + gray meta",
      seed: "<not a url> ",
      events: [],
      checkpoints: [
        { at: 0, expect: "<m><not a url></m> |" },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 3. Inline `<kbd>` in a paragraph → widget when cursor outside.
    // ──────────────────────────────────────────────────────────────
    {
      id: "inline-kbd",
      label: "`press <kbd>Ctrl</kbd> here` → inline widget outside cursor",
      seed: "press <kbd>Ctrl</kbd> here",
      events: ["<Home>"],
      checkpoints: [
        { at: 1, expect: "|press <html-inline/> here" },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 4. CommonMark fragments `<p>...\n\n...</p>` at blank lines.
    //    Each fragment becomes its own html_block: opener-only block
    //    (empty after chrome hide), then `<img/>` block (widget), then
    //    `</p>` block (gray-meta). Matches Typora's per-block model.
    // ──────────────────────────────────────────────────────────────
    {
      id: "fragments-at-blank-lines",
      label: "<p>\\n\\n<img/>\\n\\n</p> fragments into three blocks",
      seed: '<p align="center">\n\n<img alt="x" src="/y"/>\n\n</p>\n\nafter',
      events: [],
      checkpoints: [
        {
          at: 0,
          // Block 1: just `<p align="center">` chrome → empty after hide
          // Block 2: just `<img/>` → widget
          // Block 3: just `</p>` → md-it sees no surviving HTML after
          //          sanitize and routes back to a paragraph; gray-meta
          //          decoration still applies in paragraph context.
          expect:
            "<html-block></html-block>\n<html-block><html-inline/></html-block>\n<m></p></m>\nafter|",
        },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 5. Cursor inside the html_block → source visible (gray meta on
    //    chrome tags + caret rendered).
    // ──────────────────────────────────────────────────────────────
    {
      id: "cursor-inside-html-block",
      label: "cursor inside html_block → source visible, caret rendered",
      seed: "<details>x</details>",
      events: [],
      checkpoints: [
        {
          at: 0,
          expect: "<html-block><m><details></m>x<m></details></m>|</html-block>",
        },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 6. `<a><img></a>` (badge pattern) renders inline.
    // ──────────────────────────────────────────────────────────────
    {
      id: "link-wrapped-image",
      label: "<a href><img></a> badge inside hidden <p> chrome",
      seed: '<p align="center"><a href="https://x"><img src="/y"/></a></p>\n\nafter',
      events: [],
      checkpoints: [
        {
          at: 0,
          expect:
            "<html-block><html-inline/><m></p></m></html-block>\nafter|",
        },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 7. attrs containing `>` (e.g. CSS selectors, comparison)
    //    must not break the tokenizer.
    // ──────────────────────────────────────────────────────────────
    {
      id: "attr-with-gt",
      label: "<kbd title='a>b'>X</kbd> attrs with `>` still tokenize",
      seed: 'press <kbd title="a>b">X</kbd> now',
      events: ["<Home>"],
      checkpoints: [
        { at: 1, expect: "|press <html-inline/> now" },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 8. Two sibling inline tags — both render as widgets.
    // ──────────────────────────────────────────────────────────────
    {
      id: "two-siblings",
      label: "<kbd>a</kbd> + <kbd>b</kbd> both render",
      seed: "press <kbd>A</kbd> then <kbd>B</kbd>",
      events: ["<Home>"],
      checkpoints: [
        { at: 1, expect: "|press <html-inline/> then <html-inline/>" },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 9. Plain `<a>text</a>` (no img) renders as inline widget.
    //    This was the Vditor README regression that motivated the
    //    tokenizer rewrite.
    // ──────────────────────────────────────────────────────────────
    {
      id: "plain-anchor-text",
      label: "<a href>text</a> renders; surrounding <p> chrome hidden",
      seed: '<p><a href="https://x">English</a> | <a href="https://y">中文</a></p>\n\nafter',
      events: [],
      checkpoints: [
        {
          at: 0,
          expect:
            "<html-block><html-inline/> | <html-inline/><m></p></m></html-block>\nafter|",
        },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 10. Unbalanced `<span>foo` stays as raw text — no widget.
    // ──────────────────────────────────────────────────────────────
    {
      id: "unbalanced-open",
      label: "<span>foo (no closer) → gray meta on the orphan tag",
      seed: "<span>foo",
      events: [],
      checkpoints: [
        { at: 0, expect: "<m><span></m>foo|" },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 11. HTML entities (`&nbsp;`, `&amp;`) inside an html_block
    //     render as the decoded character via inline widgets.
    //     (markdown-it decodes entities in plain paragraphs at parse
    //     time, so this only kicks in for the html_block context
    //     where the source is preserved verbatim.)
    //
    //     The wrapping `<p>` chrome opener is hidden; the closing
    //     `</p>` shows as gray-meta.
    // ──────────────────────────────────────────────────────────────
    {
      id: "entities-render",
      label: "&nbsp; inside html_block renders as decoded widget",
      seed: "<p>English&nbsp;|&nbsp;Demo</p>\n\nafter",
      events: [],
      checkpoints: [
        {
          at: 0,
          expect:
            "<html-block>English<html-inline/>|<html-inline/>Demo<m></p></m></html-block>\nafter|",
        },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 12. Block-chrome with no align attr — opener still hides; no
    //     alignment wrapper applied.
    // ──────────────────────────────────────────────────────────────
    {
      id: "block-chrome-no-align",
      label: "<div>x</div> hides opener; closer stays as gray meta",
      seed: "<div>hello</div>\n\nafter",
      events: [],
      checkpoints: [
        {
          at: 0,
          expect: "<html-block>hello<m></div></m></html-block>\nafter|",
        },
      ],
    },
  ],
};
