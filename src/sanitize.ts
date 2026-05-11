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
  // Inline text
  "b", "i", "strong", "em", "tt", "code", "kbd", "samp", "var", "q",
  "sub", "sup", "s", "strike", "del", "ins", "mark",
  "abbr", "acronym", "cite", "address",
  "ruby", "rt", "rp",
  // Block containers
  "div", "span", "pre", "blockquote",
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
  // Generic
  "id", "class", "title", "lang", "dir",
  // Links
  "href", "rel", "target", "name",
  // Media
  "src", "alt", "srcset", "sizes", "media", "type",
  "width", "height",
  // Tables
  "align", "valign", "colspan", "rowspan", "scope", "headers", "abbr", "span",
  // Disclosure
  "open",
];

const FORBID_TAGS = [
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
  ALLOW_DATA_ATTR: false,
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
