// Text-level MDX handling for the Markdown renderer: telling MDX from plain
// Markdown, taking frontmatter and ESM out, and keeping JSX elements whole when
// the text is drawn block by block. Nothing here (or anywhere) runs the text:
// MDX is parsed for its syntax and drawn as data.
//
// Detection is deliberately narrow, so ordinary agent messages (prose with `<`,
// `{`, `<br>` or HTML comments) keep the plain Markdown path. A text is MDX
// when, outside code, it has YAML frontmatter, an `import … from "…"` /
// `export const …` line, or a capitalised JSX tag starting a line that
// self-closes or is closed later (`<Tabs>` … `</Tabs>`).

import { splitBlocks } from "@/lib/markdown-blocks";

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
/** A YAML line that makes `---` … `---` frontmatter rather than a rule and a heading. */
const YAML_KEY = /^[A-Za-z_][\w-]*:(\s|$)/m;
const IMPORT = /^import\s+(?:["']|[\w*{$][^\n]*?\bfrom\s*["'])/;
const EXPORT = /^export\s+(?:const|let|var|function|class|default|async|\{|\*)/;
/** A capitalised tag starting a line (in a quote or a list item too). */
const JSX_START = /^(?:\s*(?:>|[-+*]|\d{1,9}[.)])(?=\s))*\s*<([A-Z]\w*(?:\.\w+)*)(?=[\s/>]|$)/;
/** HTML elements with no content, which MDX wants written `<br />`. */
const VOID = new Set(["br", "hr", "img", "input", "wbr", "source", "col", "area", "embed", "track"]);

/** Each line of `text` outside fenced code, with inline code spans blanked. */
function* proseLines(text: string): Generator<string> {
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      continue;
    }
    if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = f[1];
      continue;
    }
    yield line.replace(/(`+)[^`]*?\1/g, (m) => " ".repeat(m.length));
  }
}

/** The frontmatter block at the very start (its YAML and the rest of the text), if there is one. */
export function splitFrontmatter(text: string): { yaml: string | null; body: string } {
  const m = FRONTMATTER.exec(text);
  if (!m || !YAML_KEY.test(m[1])) return { yaml: null, body: text };
  return { yaml: m[1], body: text.slice(m[0].length) };
}

/** Whether `text` should be drawn as MDX (see the top of this file). */
export function looksLikeMdx(text: string): boolean {
  if (splitFrontmatter(text).yaml !== null) return true;
  const lines = [...proseLines(text)];
  for (const [i, line] of lines.entries()) {
    if (IMPORT.test(line) || EXPORT.test(line)) return true;
    const m = JSX_START.exec(line);
    if (!m) continue;
    // From the `<` on: closed later, or self-closing.
    const rest = lines
      .slice(i)
      .join("\n")
      .slice(m[0].length - m[1].length - 1);
    if (rest.includes(`</${m[1]}>`) || /^<[\w.]+(?:\s[^<>]*)?\/>/.test(rest)) return true;
  }
  return false;
}

/**
 * The text with its ESM (`import`/`export` statements, up to the next blank line,
 * as MDX reads them) and HTML comments taken out, and void HTML tags written the
 * way MDX accepts (`<br>` → `<br />`). Fenced code is left alone.
 */
export function prepareMdx(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let esm = false;
  let comment = false;
  for (const line of text.split("\n")) {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = null;
      out.push(line);
      continue;
    }
    if (esm && line.trim()) continue;
    esm = !comment && (IMPORT.test(line) || EXPORT.test(line));
    if (esm) continue;
    if (!comment && f && !(f[1][0] === "`" && f[2].includes("`"))) {
      fence = f[1];
      out.push(line);
      continue;
    }
    // A line that is only an MDX comment (`{/* … */}`) shows nothing: gone here, so no empty block is left.
    if (!comment && /^\s*\{\s*\/\*.*?\*\/\s*\}\s*$/.test(line)) continue;
    // Outside inline code: drop HTML comments (MDX has none), close void tags.
    const parts = line.split(/(`+[^`]*?`+)/);
    for (let i = 0; i < parts.length; i += 2) {
      let s = parts[i];
      if (comment) {
        const end = s.indexOf("-->");
        if (end < 0) {
          parts[i] = "";
          continue;
        }
        s = s.slice(end + 3);
        comment = false;
      }
      s = s.replace(/<!--[\s\S]*?-->/g, "");
      const start = s.indexOf("<!--");
      if (start >= 0) {
        s = s.slice(0, start);
        comment = true;
      }
      parts[i] = s.replace(/<([a-z]+)(\s[^<>]*?)?\s*(\/?)>/g, (m, name: string, attrs = "", slash: string) =>
        VOID.has(name) && !slash ? `<${name}${attrs} />` : m,
      );
      if (comment) {
        parts.length = i + 1;
        break;
      }
    }
    out.push(parts.join(""));
  }
  return out.join("\n");
}

/**
 * The JSX elements still open at the end of `text`, outermost first, starting from
 * `open`. A rough scan (it skips code, quoted attribute values and braces) that only
 * has to be right enough to keep an element's blocks together.
 */
export function openTags(text: string, open: string[] = []): string[] {
  const stack = [...open];
  /** Inside `<…`: its name, whether it is a closing tag, the last non-space character. */
  let tag: { name: string; closing: boolean; last: string } | null = null;
  let quote: string | null = null;
  let braces = 0;
  for (const line of proseLines(text)) {
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
      const m = /^<(\/?)([A-Za-z][\w.:-]*)?/.exec(line.slice(i));
      // `<` then a name or `>` (a fragment) opens a tag; `a < b` doesn't.
      if (m && (m[2] || line[i + m[0].length] === ">")) {
        tag = { name: m[2] ?? "", closing: m[1] === "/", last: "" };
        i += m[0].length - 1;
      }
    }
  }
  return stack;
}

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

// ── The MDX renderer, loaded on first use ───────────────────────────────────

type MdxRenderer = typeof import("@/lib/mdx-render");
let renderer: MdxRenderer | null = null;
let loading: Promise<MdxRenderer> | null = null;
const listeners = new Set<() => void>();

/** Loads the MDX renderer (its own chunk: most chats never need it). */
export function loadMdx(): Promise<MdxRenderer> {
  return (loading ??= import("@/lib/mdx-render").then(
    (m) => {
      renderer = m;
      for (const l of listeners) l();
      return m;
    },
    (e: unknown) => {
      loading = null;
      throw e;
    },
  ));
}

/** The MDX renderer if it has loaded. */
export const mdxRenderer = () => renderer;

export function onMdxLoaded(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
