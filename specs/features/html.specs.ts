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
      return null;
    },
  },
  cases: [
    // ──────────────────────────────────────────────────────────────
    // 1. Block-level <details> stays as a single html_block with the
    //    raw source visible (no scanner match → no widgets).
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
            "<html-block><details><summary>X</summary>body</details></html-block>\nafter|",
        },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 2. `<not a url>` (md-it html_block type 7) doesn't survive
    //    sanitize → routed back to a plain paragraph.
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
    // 4. Paired-tag scanner keeps `<p>…\n\n…</p>` together as one
    //    html_block; the embedded `<img/>` is rendered inline by the
    //    scanner; the `<p>` / `</p>` chrome is softInside-hidden so
    //    the cursor-outside view shows just the rendered content.
    // ──────────────────────────────────────────────────────────────
    {
      id: "paired-tag-keeps-blanks",
      label: "<p>\\n\\n<img/>\\n\\n</p> chrome hidden; img renders inline",
      seed: '<p align="center">\n\n<img alt="x" src="/y"/>\n\n</p>\n\nafter',
      events: [],
      checkpoints: [
        {
          at: 0,
          expect: `<html-block>\n\n<html-inline/>\n\n</html-block>\nafter|`,
        },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 5. Cursor inside the html_block → block stays editable as text
    //    (source is the doc content; matches Typora's mixed view).
    // ──────────────────────────────────────────────────────────────
    {
      id: "cursor-inside-html-block",
      label: "cursor inside html_block → source visible, caret rendered",
      seed: "<details>x</details>",
      events: [],
      checkpoints: [
        { at: 0, expect: "<html-block><details>x</details>|</html-block>" },
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
          expect: `<html-block><html-inline/></html-block>\nafter|`,
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
          expect: `<html-block><html-inline/> | <html-inline/></html-block>\nafter|`,
        },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 10. Unbalanced `<span>foo` stays as raw text — no widget.
    // ──────────────────────────────────────────────────────────────
    {
      id: "unbalanced-open",
      label: "<span>foo (no closer) stays raw",
      seed: "<span>foo",
      events: [],
      checkpoints: [
        { at: 0, expect: "<span>foo|" },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 11. HTML entities (`&nbsp;`, `&amp;`) inside an html_block
    //     render as the decoded character via inline widgets.
    //     (markdown-it decodes entities in plain paragraphs at parse
    //     time, so this only kicks in for the html_block context
    //     where the source is preserved verbatim.)
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
            `<html-block>English<html-inline/>|<html-inline/>Demo</html-block>\nafter|`,
        },
      ],
    },

    // ──────────────────────────────────────────────────────────────
    // 12. Block-chrome with no align attr — chrome still hides; just
    //     no alignment wrapper applied.
    // ──────────────────────────────────────────────────────────────
    {
      id: "block-chrome-no-align",
      label: "<div>x</div> hides chrome, content stays",
      seed: "<div>hello</div>\n\nafter",
      events: [],
      checkpoints: [
        {
          at: 0,
          expect: `<html-block>hello</html-block>\nafter|`,
        },
      ],
    },
  ],
};
