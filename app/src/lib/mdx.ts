// The text side of the Markdown renderer, which reads every text as MDX (the
// tree side is lib/mdx-render.ts). Nothing here, or anywhere, runs the text: MDX
// is parsed for its syntax and drawn as data.
//
// MDX isn't quite a superset of Markdown, so `prepareMdx` first makes ordinary
// Markdown read as it always has. Outside code:
// - a `<` starts JSX only for a tag that is closed later (`</Name>`) or
//   self-closing, an HTML void element (`<br>`), or a mapped component opening
//   alone on its line (`<Note>` while it streams). Lowercase names must be ones
//   yaah draws (`kbd`, `details`, `div`…). Every other `<` is escaped, so
//   `a < b`, `Vec<T>` and `<Enter> to continue` stay text;
// - autolinks (`<https://…>`, `<a@b.co>`) are written as links;
// - HTML comments and MDX comments (`{/* … */}`) are taken out, as are
//   `import`/`export` lines;
// - braces are text: the parser has no expression syntax, so `{x}` never is one.
// Fenced and indented code is left alone. Indented code (which MDX turns off) is
// code outside components: see `scanJsx`.

import { splitBlocks } from "@/lib/markdown-blocks";

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+|$)/;
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
/** A YAML line that makes `---` … `---` frontmatter rather than a rule and a heading. */
const YAML_KEY = /^[A-Za-z_][\w-]*:(\s|$)/m;
const IMPORT = /^import\s+(?:["']|[\w*{$][^\n]*?\bfrom\s*["'])/;
const EXPORT =
  /^export\s+(?:(?:const|let|var)\s+[\w$]+\s*=|(?:async\s+)?function\s*\*?\s*[\w$]*\s*\(|class\s+[\w$]+[^\n]*\{\s*$|default\s+(?:(?:async\s+)?function\b|class\b|[{[(]|[\w$.]+\s*;?\s*$)|\{|\*\s)/;
const MDX_COMMENT_LINE = /^\s*\{\s*\/\*.*?\*\/\s*\}\s*$/;
/** Where a line's content starts, past quote and list markers. */
const CONTAINERS = /^(?:[ \t]*(?:>|[-+*]|\d{1,9}[.)])(?=[ \t]))*[ \t]*/;
/** An autolink's URL: a scheme, then no spaces, controls or angle brackets. */
const AUTOLINK = /<([A-Za-z][A-Za-z\d+.-]{1,31}:[^<>\p{Cc} ]*)>/uy;
const EMAIL = /<([\w.!#$%&'*+/=?^`{|}~-]+@[A-Za-z\d](?:[A-Za-z\d-]{0,61}[A-Za-z\d])?(?:\.[A-Za-z\d](?:[A-Za-z\d-]{0,61}[A-Za-z\d])?)*)>/y;
const OPEN_TAG = /<([A-Za-z_$][\w$.:-]*)?(?=[\s/>]|$)/y;
const CLOSE_TAG = /<\/([A-Za-z_$][\w$.:-]*)?\s*>/y;
const MDX_COMMENT = /\{\s*\/\*/y;
/** What comes before a link destination written in `<…>`: `[a](<b c>)` or `[a]: <b c>`. */
const DESTINATION = /(?:\]\(|^ {0,3}\[[^\]]+\]:[ \t]*)$/;
/** The next character `prepareMdx` has to look at. */
const SPECIAL = /[\n\\`<{]/g;

// ── Names ───────────────────────────────────────────────────────────────────
// Maps and sets, not objects: a tag or prop named `constructor` or `__proto__` must find nothing.

export const ADMONITIONS = new Set(["Admonition", "Callout", "Note", "Tip", "Info", "Warning", "Caution", "Danger", "Important"]);
export const KINDS = new Map([
  ["Tabs", "tabs"],
  ["TabPanel", "tab"],
  ["Tab", "tab"],
  ["TabItem", "tab"],
  ["details", "details"],
  ["Details", "details"],
  ["summary", "summary"],
  ["Summary", "summary"],
  ["Steps", "steps"],
  ["Step", "step"],
  ["Cards", "cards"],
  ["CardGroup", "cards"],
  ["Card", "card"],
]);
/** HTML elements drawn as themselves, with no attributes. */
export const HTML = new Map([
  ..."kbd sub sup mark u small abbr ul ol li table thead tbody tr th td blockquote h1 h2 h3 h4 h5 h6 hr br p pre code figure figcaption strong em del"
    .split(" ")
    .map((t): [string, string] => [t, t]),
  ["b", "strong"],
  ["i", "em"],
  ["s", "del"],
]);
/** Wrappers whose children are shown in their place. */
export const TRANSPARENT = new Set(["", "div", "span", "section", "article", "main", "header", "footer", "center", "Fragment"]);
/** HTML elements with no content, which MDX wants written `<br />`. */
const VOID = new Set(["br", "hr", "img", "input", "wbr", "source", "col", "area", "embed", "track"]);
/** Components that may open alone on a line before their closing tag has arrived. */
const MAPPED = new Set([...ADMONITIONS, ...KINDS.keys(), "Image"]);
/** A name written like an HTML element; JSX only if yaah draws it (any other name is a component). */
const HTML_NAME = /^[a-z][a-z\d-]*$/;
const drawn = (name: string) => !HTML_NAME.test(name) || HTML.has(name) || TRANSPARENT.has(name) || KINDS.has(name) || name === "a" || name === "img";

// ── Lines ───────────────────────────────────────────────────────────────────

function indentOf(line: string): number {
  let col = 0;
  for (const c of line) {
    if (c === " ") col++;
    else if (c === "\t") col += 4 - (col % 4);
    else break;
  }
  return col;
}

/**
 * A line-by-line test for code: fenced code (with its fence lines), and indented
 * code where CommonMark has it, unless `open` (inside a JSX element, where
 * indentation is only indentation, as in MDX).
 */
function codeLines(): (line: string, open: boolean) => boolean {
  let fence: string | null = null;
  let blank = true;
  let code = false;
  /** The content indent of the list item last seen. */
  let list = 0;
  return (line, open) => {
    if (fence) {
      const f = FENCE.exec(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      return true;
    }
    if (!line.trim()) {
      blank = true;
      return false;
    }
    const indent = indentOf(line);
    const afterBlank = blank;
    blank = false;
    if (!open && indent >= list + 4 && (afterBlank || code)) return (code = true);
    code = false;
    const f = FENCE.exec(line);
    // A backtick fence's info string can't hold backticks (then it's inline code).
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = f[1];
      return true;
    }
    const item = LIST_ITEM.exec(line);
    if (item) list = item[1].length + item[2].length + (item[3].length >= 1 && item[3].length <= 4 ? item[3].length : 1);
    else if (afterBlank && indent < list) list = 0;
    return false;
  };
}

/** `text` with fenced code and inline code spans blanked (same length, so offsets still match). */
function maskCode(text: string): string {
  const isCode = codeLines();
  return text
    .split("\n")
    .map((line) => (isCode(line, true) ? " ".repeat(line.length) : line.replace(/(`+)[^`]*?\1/g, (m) => " ".repeat(m.length))))
    .join("\n");
}

/** The frontmatter block at the very start (its YAML and the rest of the text), if there is one. */
export function splitFrontmatter(text: string): { yaml: string | null; body: string } {
  const m = FRONTMATTER.exec(text);
  if (!m || !YAML_KEY.test(m[1])) return { yaml: null, body: text };
  return { yaml: m[1], body: text.slice(m[0].length) };
}

// ── The compatibility pass ──────────────────────────────────────────────────

/** A link written as `[text](<url>)`, the text escaped so it shows as written. */
const link = (text: string, url: string) => `[${text.replace(/[!-/:-@[-`{-~]/g, "\\$&")}](<${url.replace(/[\\<>]/g, "\\$&")}>)`;

/** Where the `<…>` tag whose name ends at `from` ends (its `>`), or -1 if it doesn't (`a<b then`, a tag still streaming). */
function tagEnd(text: string, from: number): number {
  let quote: string | null = null;
  let braces = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") {
      // A blank line ends any tag.
      let k = i + 1;
      while (text[k] === " " || text[k] === "\t") k++;
      if (k >= text.length || text[k] === "\n") return -1;
    }
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "{") braces++;
    else if (c === "}") braces = Math.max(0, braces - 1);
    else if (!braces && c === ">") return i;
    else if (!braces && c === "<") return -1;
  }
  return -1;
}

/**
 * The text as the MDX parser should see it (see the top of this file): ESM and
 * comments out, autolinks as links, void tags closed, and every `<` that doesn't
 * start JSX escaped. With `jsx: false`, no `<` starts JSX (the last resort for a
 * block that won't parse).
 */
export function prepareMdx(text: string, { jsx = true } = {}): string {
  const masked = maskCode(text);
  const isCode = codeLines();
  /** The JSX elements open at this point, outermost first. */
  const stack: string[] = [];
  let out = "";

  /** Whether `</name>` comes later, outside code. */
  const closedLater = (name: string, from: number) => {
    const needle = `</${name}`;
    for (let k = masked.indexOf(needle, from); k >= 0; k = masked.indexOf(needle, k + 1)) {
      let e = k + needle.length;
      while (/\s/.test(masked[e] ?? "")) e++;
      if (masked[e] === ">") return true;
    }
    return false;
  };

  /** Handles the `<` at `j`; returns where to go on. */
  const angle = (j: number): number => {
    const lineStart = text.lastIndexOf("\n", j - 1) + 1;
    let lineEnd = text.indexOf("\n", j);
    if (lineEnd < 0) lineEnd = text.length;
    // A link destination, `[a](<b c>)` or `[a]: <b c>`, as written.
    if (DESTINATION.test(out.slice(out.lastIndexOf("\n") + 1))) {
      const end = text.indexOf(">", j);
      if (end >= 0 && end < lineEnd) {
        out += text.slice(j, end + 1);
        return end + 1;
      }
    }
    for (const [re, scheme] of [
      [AUTOLINK, ""],
      [EMAIL, "mailto:"],
    ] as const) {
      re.lastIndex = j;
      const m = re.exec(text);
      if (m) {
        out += link(m[1], scheme + m[1]);
        return j + m[0].length;
      }
    }
    if (jsx) {
      CLOSE_TAG.lastIndex = j;
      const close = CLOSE_TAG.exec(text);
      const at = close ? stack.lastIndexOf(close[1] ?? "") : -1;
      if (close && at >= 0) {
        stack.length = at;
        out += close[0];
        return j + close[0].length;
      }
      OPEN_TAG.lastIndex = j;
      const open = close ? null : OPEN_TAG.exec(text);
      const name = open?.[1] ?? "";
      const end = open && (name || text[j + 1] === ">") && drawn(name) ? tagEnd(text, j + open[0].length) : -1;
      if (end >= 0) {
        const self = text.slice(j, end).trimEnd().endsWith("/");
        const isVoid = VOID.has(name);
        const after = text.indexOf("\n", end);
        const alone =
          CONTAINERS.exec(text.slice(lineStart, j))![0].length === j - lineStart && !text.slice(end + 1, after < 0 ? undefined : after).trim();
        // A fragment (`<>…</>`) only on lines of its own, so `a <> b` stays text.
        const accept = name ? self || isVoid || closedLater(name, end) || (MAPPED.has(name) && alone) : alone && closedLater(name, end);
        if (accept) {
          if (!self && !isVoid) stack.push(name);
          out += isVoid && !self ? `${text.slice(j, end).trimEnd()} />` : text.slice(j, end + 1);
          return end + 1;
        }
      }
    }
    out += "\\<";
    return j + 1;
  };

  const isMdxComment = (j: number) => {
    MDX_COMMENT.lastIndex = j;
    return MDX_COMMENT.test(text);
  };

  /** Copies prose from `i` (a line start) to the end of its line, or past it when a tag, comment or code span goes on. */
  const prose = (i: number): number => {
    let j = i;
    while (j < text.length) {
      SPECIAL.lastIndex = j;
      const next = SPECIAL.exec(text)?.index ?? text.length;
      out += text.slice(j, next);
      j = next;
      if (j >= text.length) break;
      const c = text[j];
      if (c === "\n") {
        out += c;
        return j + 1;
      }
      if (c === "\\") {
        // An escape stays as written (a backslash at the end of a line is a hard break).
        const n = text[j + 1] === "\n" || j + 1 >= text.length ? 1 : 2;
        out += text.slice(j, j + n);
        j += n;
      } else if (c === "`") {
        // A code span, as written, if it closes before the paragraph ends.
        let k = j;
        while (text[k] === "`") k++;
        const run = text.slice(j, k);
        const close = new RegExp(`(?<!\`)${run}(?!\`)|\\n[ \\t]*\\n`, "g");
        close.lastIndex = k;
        const m = close.exec(text);
        const end = m && m[0] === run ? m.index + run.length : k;
        out += text.slice(j, end);
        j = end;
      } else if (c === "<" && text.startsWith("<!--", j)) {
        const end = text.indexOf("-->", j + 4);
        j = end < 0 ? text.length : end + 3;
      } else if (c === "{" && isMdxComment(j)) {
        const end = /\*\/\s*\}/g;
        end.lastIndex = j;
        const m = end.exec(text);
        j = m ? m.index + m[0].length : text.length;
      } else if (c === "<") j = angle(j);
      else {
        out += c;
        j++;
      }
    }
    return j;
  };

  let esm = false;
  for (let i = 0; i < text.length;) {
    let eol = text.indexOf("\n", i);
    eol = eol < 0 ? text.length : eol + 1;
    const line = text.slice(i, eol).replace(/\n$/, "");
    if (isCode(line, stack.length > 0)) {
      out += text.slice(i, eol);
      i = eol;
      continue;
    }
    // ESM: its statements up to the next blank line, as MDX reads them.
    if (esm && line.trim()) {
      i = eol;
      continue;
    }
    esm = IMPORT.test(line) || EXPORT.test(line);
    // A line that is only an MDX comment shows nothing: gone, so no empty block is left.
    if (esm || MDX_COMMENT_LINE.test(line)) {
      i = eol;
      continue;
    }
    i = prose(i);
  }
  return out;
}

// ── JSX in prepared text ────────────────────────────────────────────────────

/**
 * The JSX elements still open at the end of prepared `text`, outermost first,
 * starting from `open`, and whether a tag starts a line (a component in flow,
 * which turns indented code off for its block). A rough scan (it skips code,
 * escapes, quoted attribute values and braces) that only has to be right enough
 * to keep an element's blocks together.
 */
export function scanJsx(text: string, open: string[] = []): { open: string[]; flow: boolean } {
  const stack = [...open];
  const isCode = codeLines();
  let flow = false;
  /** Inside `<…`: its name, whether it is a closing tag, the last non-space character. */
  let tag: { name: string; closing: boolean; last: string } | null = null;
  let quote: string | null = null;
  let braces = 0;
  for (const raw of text.split("\n")) {
    if (!tag && isCode(raw, stack.length > 0)) continue;
    const line = raw.replace(/(`+)[^`]*?\1/g, (m) => " ".repeat(m.length));
    const lead = CONTAINERS.exec(line)![0].length;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (tag) {
        if (quote) {
          if (c === quote) quote = null;
        } else if (braces) {
          if (c === "{") braces++;
          else if (c === "}") braces--;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "{") braces = 1;
        else if (c === ">") {
          if (tag.closing) {
            const at = stack.lastIndexOf(tag.name);
            if (at >= 0) stack.length = at;
          } else if (tag.last !== "/" && !VOID.has(tag.name)) stack.push(tag.name);
          tag = null;
          continue;
        }
        if (tag && c.trim()) tag.last = c;
        continue;
      }
      if (c === "\\") {
        i++;
        continue;
      }
      if (c !== "<") continue;
      // A link destination isn't a tag.
      if (DESTINATION.test(line.slice(0, i))) {
        const end = line.indexOf(">", i);
        if (end >= 0) i = end;
        continue;
      }
      const m = /^<(\/?)([A-Za-z_$][\w$.:-]*)?/.exec(line.slice(i));
      // `<` then a name or `>` (a fragment) opens a tag; `a < b` doesn't.
      if (m && (m[2] || line[i + m[0].length] === ">")) {
        if (i === lead) flow = true;
        tag = { name: m[2] ?? "", closing: m[1] === "/", last: "" };
        i += m[0].length - 1;
      }
    }
  }
  return { open: stack, flow };
}

export const openTags = (text: string, open: string[] = []) => scanJsx(text, open).open;

/** `text` in top-level blocks (as `splitBlocks`), with blocks inside an open JSX element joined to it. */
export function mdxBlocks(text: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  let open: string[] = [];
  for (const block of splitBlocks(text)) {
    current = current === null ? block : `${current}\n${block}`;
    open = openTags(block, open);
    if (!open.length) {
      out.push(current);
      current = null;
    }
  }
  if (current !== null) out.push(current);
  return out;
}
