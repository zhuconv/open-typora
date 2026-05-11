// Position-aware HTML tokenizer + bracket pairing.
//
// Why this exists: the previous html feature scanned 4 regexes
// (link-img / paired-inline / img / link-text) in sequence. That breaks
// the moment attrs contain `>` (e.g. `<a title="a>b">x</a>`), nested
// same-name tags appear, or someone reaches outside the hardcoded tag
// allowlist. Replacing that with a real grammar-driven tokenizer +
// stack-based pairing covers all those cases with one path.
//
// Grammar is vendored from markdown-it's `lib/common/html_re.mjs` so we
// stay byte-compatible with what markdown-it itself accepts as inline
// raw HTML (CommonMark §6.6). Pairing is HTML5-style (case-insensitive
// tag matching, longest-balanced match wins on nested re-opens); we
// don't model HTML5's implicit-close rules — that's parser territory,
// and editor-side users rarely write them.

// ─────────────────────────────────────────────────────────────────────────────
// Grammar — verbatim from markdown-it (CommonMark §6.6)
// ─────────────────────────────────────────────────────────────────────────────

const TAG_NAME = "[A-Za-z][A-Za-z0-9\\-]*";
const ATTR_NAME = "[a-zA-Z_:][a-zA-Z0-9:._-]*";
const UNQUOTED = "[^\"'=<>`\\x00-\\x20]+";
const SINGLE_QUOTED = "'[^']*'";
const DOUBLE_QUOTED = '"[^"]*"';
const ATTR_VALUE = "(?:" + UNQUOTED + "|" + SINGLE_QUOTED + "|" + DOUBLE_QUOTED + ")";
const ATTRIBUTE = "(?:\\s+" + ATTR_NAME + "(?:\\s*=\\s*" + ATTR_VALUE + ")?)";

// Capture group 1 = open-tag name, group 2 = self-closing slash.
const OPEN_TAG = "<(" + TAG_NAME + ")" + ATTRIBUTE + "*\\s*(\\/?)>";
// Capture group 3 = close-tag name.
const CLOSE_TAG = "<\\/(" + TAG_NAME + ")\\s*>";
const COMMENT = "<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->";
const PROCESSING = "<\\?[\\s\\S]*?\\?>";
const DECLARATION = "<![A-Za-z][^>]*>";
const CDATA = "<!\\[CDATA\\[[\\s\\S]*?\\]\\]>";

const HTML_TAG_RE_G = new RegExp(
  "(?:" + OPEN_TAG + ")|(?:" + CLOSE_TAG + ")|(?:" + COMMENT +
  ")|(?:" + PROCESSING + ")|(?:" + DECLARATION + ")|(?:" + CDATA + ")",
  "g",
);

// HTML5 void elements — never have a closing tag.
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr",
  "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Token model
// ─────────────────────────────────────────────────────────────────────────────

export type HtmlToken =
  | { kind: "open"; tag: string; selfClosing: boolean; start: number; end: number; source: string }
  | { kind: "close"; tag: string; start: number; end: number; source: string }
  | { kind: "comment" | "decl" | "cdata" | "pi"; start: number; end: number; source: string };

export function tokenizeHtmlTags(text: string): HtmlToken[] {
  const out: HtmlToken[] = [];
  HTML_TAG_RE_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HTML_TAG_RE_G.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    const source = m[0];
    if (m[1] !== undefined) {
      out.push({
        kind: "open",
        tag: m[1],
        selfClosing: m[2] === "/",
        start, end, source,
      });
    } else if (m[3] !== undefined) {
      out.push({ kind: "close", tag: m[3], start, end, source });
    } else if (source.startsWith("<!--")) {
      out.push({ kind: "comment", start, end, source });
    } else if (source.startsWith("<![CDATA[")) {
      out.push({ kind: "cdata", start, end, source });
    } else if (source.startsWith("<!")) {
      out.push({ kind: "decl", start, end, source });
    } else if (source.startsWith("<?")) {
      out.push({ kind: "pi", start, end, source });
    }
    // Guard against zero-length match infinite loop (shouldn't happen here
    // because every alternative starts with `<`, but be defensive).
    if (HTML_TAG_RE_G.lastIndex === start) HTML_TAG_RE_G.lastIndex = start + 1;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing — stack-based balanced bracket match
// ─────────────────────────────────────────────────────────────────────────────

export type HtmlMatch =
  | {
      kind: "pair";
      tag: string;            // case-preserved from the opening tag
      start: number;          // position of `<` in the opening tag
      end: number;            // position after `>` of the closing tag
      openEnd: number;        // position after `>` of the opening tag
      closeStart: number;     // position of `<` in the closing tag
    }
  | {
      kind: "void";
      tag: string;
      start: number;
      end: number;
    };

// Pair up tokens into rendered HTML matches. Unmatched opens / closes
// are dropped silently — caller renders them as plain source text.
//
// Nesting: a `<span><span>x</span></span>` produces TWO pairs (inner +
// outer); the outer's range fully contains the inner's. Caller decides
// whether to render both or only the outermost.
export function pairTags(tokens: HtmlToken[]): HtmlMatch[] {
  const matches: HtmlMatch[] = [];
  const stack: Array<{ tag: string; tagLow: string; start: number; openEnd: number }> = [];
  for (const t of tokens) {
    if (t.kind === "open") {
      const low = t.tag.toLowerCase();
      if (t.selfClosing || VOID_TAGS.has(low)) {
        matches.push({ kind: "void", tag: t.tag, start: t.start, end: t.end });
        continue;
      }
      stack.push({ tag: t.tag, tagLow: low, start: t.start, openEnd: t.end });
    } else if (t.kind === "close") {
      const low = t.tag.toLowerCase();
      let idx = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.tagLow === low) { idx = i; break; }
      }
      if (idx < 0) continue; // unmatched close — leave as raw source
      const open = stack[idx]!;
      // Discard any unbalanced opens that lived between (they don't
      // become matches — their source stays raw).
      stack.length = idx;
      matches.push({
        kind: "pair",
        tag: open.tag,
        start: open.start,
        end: t.end,
        openEnd: open.openEnd,
        closeStart: t.start,
      });
    }
    // Other token kinds (comment / decl / cdata / pi) don't participate
    // in pairing. Comments are owned by html-comment feature; the rest
    // stay raw.
  }
  return matches;
}
