// HTML sanitizer with a GitHub-Flavored-Markdown-style allowlist.
//
// Reference: github/html-pipeline `SanitizationFilter` —
// https://github.com/gjtorikian/html-pipeline/blob/main/lib/html_pipeline/sanitization_filter.rb
//
// What survives: structural / textual HTML you'd see in a README — headings,
// lists, tables, <details>/<summary>, <kbd>, <img>, <a>, …
//
// What gets stripped: scripts, styles, iframes, forms, inputs, event-handler
// attrs, javascript: / data: URLs (modulo image data URIs which DOMPurify
// permits for <img>).

import DOMPurify from "dompurify";

const ALLOWED_TAGS = [
  // Headings + paragraphs
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "br", "hr",
  // Inline text — phrasing content. Slight superset of GitHub's
  // html-pipeline list to keep legacy README markup working (`<u>`,
  // `<font>`, `<big>` etc. show up in old projects).
  "b", "i", "strong", "em", "u", "tt", "code", "kbd", "samp", "var", "q",
  "sub", "sup", "s", "strike", "del", "ins", "mark",
  "small", "big", "font",
  "abbr", "acronym", "cite", "address",
  "bdo", "bdi", "dfn", "time", "wbr",
  "ruby", "rt", "rp",
  // Block containers
  "div", "span", "pre", "blockquote", "section", "article", "aside",
  "header", "footer", "nav", "main", "figure", "figcaption",
  // Lists
  "ul", "ol", "li", "dl", "dd", "dt",
  // Tables
  "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "caption", "colgroup", "col",
  // Disclosure
  "details", "summary",
  // Media
  "img", "picture", "source",
  // Links
  "a",
];

const ALLOWED_ATTR = [
  // Generic — `class` / `id` / `data-*` deliberately survive. Typora
  // strips these at render time (kept only on export), which prevents
  // CSS targeting in the live editor. We keep them so users can author
  // styled README HTML and see it as-rendered.
  "id", "class", "title", "lang", "dir", "role", "tabindex",
  // Links
  "href", "rel", "target", "name", "hreflang", "download",
  // Media
  "src", "alt", "srcset", "sizes", "media", "type", "loading",
  "width", "height", "longdesc",
  // Tables
  "align", "valign", "colspan", "rowspan", "scope", "headers", "abbr", "span",
  // Disclosure / interactive
  "open", "cite", "datetime", "value", "start", "reversed",
  // Legacy `<font>` — deprecated by spec but still seen in old docs.
  "color", "face", "size",
];

const FORBID_TAGS = [
  // Hard-banned regardless of allowlist: any script execution surface
  // and any form input (we're a content viewer, not an app shell).
  "script", "style", "iframe", "frame", "frameset",
  "object", "embed", "applet",
  "form", "input", "button", "textarea", "select", "option", "optgroup",
  "fieldset", "legend", "label",
  "meta", "link", "base",
];

const SANITIZE_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  FORBID_TAGS,
  // Keep `data-*` — Typora strips these at render time (issue typora/
  // typora-issues#2442) which breaks CSS targeting. Letting them survive
  // is a deliberate divergence.
  ALLOW_DATA_ATTR: true,
  ALLOW_ARIA_ATTR: true,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  // Strip rather than escape — escaped script tags as text are confusing.
  KEEP_CONTENT: true,
  RETURN_DOM_FRAGMENT: false,
  RETURN_DOM: false,
} as const;

export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_CONFIG) as unknown as string;
}

// Re-export the config so consumers can compose / override (e.g. allow
// `<iframe>` for embeds in a controlled context).
export const gfmSanitizeConfig = SANITIZE_CONFIG;
