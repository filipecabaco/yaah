// Markdown, read as MDX and drawn as data (the text side is lib/mdx.ts). The MDX
// syntax is parsed (micromark-extension-mdx-jsx, which knows no JavaScript) and
// turned into plain Markdown nodes and boxes for a few of yaah's own components
// (components/mdx-components.tsx). No attribute or import is ever evaluated, and
// there are no expressions: there is no compiler here.
// - a small set of docs components map onto the app's primitives: admonitions
//   (`Admonition`, `Callout`, `Note`, `Tip`, `Info`, `Warning`, `Caution`,
//   `Danger`) to an alert, `Tabs` with `TabPanel`/`Tab`/`TabItem` to tabs,
//   `details`/`summary`, `Steps`/`Step`, `Cards`/`Card`, and `img`/`Image` to the
//   same image as Markdown's (remote ones wait for a click);
// - plain HTML elements draw as themselves, without their attributes;
// - any other component shows its children in a quiet box labelled with its name;
// - props are only ever string, number or boolean literals; other attribute
//   expressions are dropped.
import { createElement, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { mdxJsx } from "micromark-extension-mdx-jsx";
import { mdxJsxFromMarkdown } from "mdast-util-mdx-jsx";
import {
  Admonition,
  MdxCard,
  MdxCards,
  MdxDetails,
  MdxStep,
  MdxSteps,
  MdxSummary,
  MdxTab,
  MdxTabs,
  Unknown,
  UnknownInline,
} from "@/components/mdx-components";
import { isWebUrl } from "@/lib/links";
import { ADMONITIONS, HTML, KINDS, TRANSPARENT, prepareMdx, scanJsx } from "@/lib/mdx";

// ── The MDX tree, as far as this file reads it ──────────────────────────────

type Literal = string | number | boolean;
type Attribute =
  | { type: "mdxJsxAttribute"; name: string; value?: string | null | { type: string; value: string } }
  | { type: "mdxJsxExpressionAttribute"; value: string };
interface Node {
  type: string;
  value?: string;
  name?: string | null;
  attributes?: Attribute[];
  children?: Node[];
  url?: string;
  alt?: string;
  title?: string | null;
  data?: { hName?: string; hProperties?: Record<string, string> };
  /** Which mapped component a box is, for its container (tabs read their panels). */
  kind?: string;
  props?: Map<string, Literal>;
}

/**
 * Syntax only: MDX's JSX, with HTML and autolinks off (lib/mdx.ts writes
 * autolinks as links). Indented code stays on unless the block has a component
 * on its own lines, whose content may be indented as in MDX.
 */
function remarkMdxSyntax(this: { data(): object }, { indentedCode }: { indentedCode: boolean }) {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
  const off = ["autolink", "htmlFlow", "htmlText", ...(indentedCode ? [] : ["codeIndented"])];
  (data.micromarkExtensions ??= []).push(mdxJsx(), { disable: { null: off } });
  (data.fromMarkdownExtensions ??= []).push(mdxJsxFromMarkdown());
}

/** MDX nodes into Markdown nodes and boxes for the components below. */
function remarkMdxAsData() {
  return (tree: Node) => {
    tree.children = convert(tree.children ?? []);
  };
}

/** What each container lifts out of a paragraph of its own (a one-line `<Tab>…</Tab>`). */
const CHILD_KIND = new Map([
  ["tabs", "tab"],
  ["details", "summary"],
  ["steps", "step"],
  ["cards", "card"],
]);

function convert(nodes: Node[]): Node[] {
  return nodes.flatMap((node): Node[] => {
    switch (node.type) {
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement":
        return element(node, node.type === "mdxJsxFlowElement");
      case "paragraph": {
        // A component alone on its line (`<Note>Short.</Note>`) is a block, not text in a paragraph.
        const real = (node.children ?? []).filter((n) => !(n.type === "text" && !n.value?.trim()));
        const only = real.length === 1 && real[0].type === "mdxJsxTextElement" ? (real[0].name ?? "") : null;
        if (only !== null && !HTML.has(only) && !TRANSPARENT.has(only) && only !== "a" && only !== "img") return element(real[0], true);
        node.children = convert(node.children ?? []);
        // A block component inside a line of text can't sit in a <p>.
        if (node.children.some((n) => n.kind)) node.data = { hName: "div" };
        return [node];
      }
      default:
        if (node.children) node.children = convert(node.children);
        return [node];
    }
  });
}

/** An attribute's value if it's a literal (`"x"`, `{3}`, `{"x"}`, `{true}`, or none), else nothing. */
function literal(a: Attribute): Literal | undefined {
  if (a.type !== "mdxJsxAttribute") return undefined; // `{...spread}`
  if (a.value === null || a.value === undefined) return true;
  if (typeof a.value === "string") return a.value;
  const v = a.value.value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^(["'])[^"'\\]*\1$/.test(v)) return v.slice(1, -1);
  if (v === "true" || v === "false") return v === "true";
  return undefined;
}

function propsOf(node: Node): Map<string, Literal> {
  const props = new Map<string, Literal>();
  for (const a of node.attributes ?? []) {
    const v = literal(a);
    if (v !== undefined && a.type === "mdxJsxAttribute") props.set(a.name, v);
  }
  return props;
}

const text = (v: Literal | undefined) => (v === undefined || v === true ? undefined : String(v));
const box = (hName: string, children: Node[], properties: Record<string, string | undefined> = {}): Node => ({
  type: "mdxBox",
  data: { hName, hProperties: Object.fromEntries(Object.entries(properties).filter(([, v]) => v !== undefined)) as Record<string, string> },
  children,
});

/** Paragraphs holding only `kind` boxes (and spaces) give way to those boxes. */
function lift(children: Node[], kind: string): Node[] {
  return children.flatMap((c) => {
    if (c.type !== "paragraph" || !c.children) return [c];
    const real = c.children.filter((n) => !(n.type === "text" && !n.value?.trim()));
    return real.length && real.every((n) => n.kind === kind) ? real : [c];
  });
}

function element(node: Node, flow: boolean): Node[] {
  const name = node.name ?? "";
  const props = propsOf(node);
  let children = convert(node.children ?? []);
  const inParagraph = (n: Node) => (flow ? { type: "paragraph", children: [n] } : n);

  if (name === "img" || name === "Image") {
    const src = text(props.get("src"));
    if (!src) return [];
    return [inParagraph({ type: "image", url: src, alt: text(props.get("alt")) ?? "", title: text(props.get("title")) ?? null })];
  }
  if (name === "a") return [inParagraph({ type: "link", url: text(props.get("href")) ?? "", title: null, children })];
  if (TRANSPARENT.has(name) || (name === "p" && !flow)) return children;
  const tag = HTML.get(name);
  if (tag) return [box(tag, children)];

  const kind = ADMONITIONS.has(name) ? "admonition" : KINDS.get(name);
  if (!kind) return [box(flow ? "mdx-unknown" : "mdx-unknown-inline", children, { dataName: name })];
  const childKind = CHILD_KIND.get(kind);
  if (childKind) children = lift(children, childKind);

  let out: Node;
  switch (kind) {
    case "admonition": {
      const type = name === "Admonition" || name === "Callout" ? text(props.get("type"))?.trim() || "note" : name;
      out = box("mdx-admonition", children, { dataType: type.toLowerCase(), dataTitle: text(props.get("title") ?? props.get("label")) });
      break;
    }
    case "tabs": {
      const seen = new Set<string>();
      const tabs = children
        .filter((c) => c.kind === "tab")
        .map((panel, i) => {
          const p = panel.props ?? new Map<string, Literal>();
          let value = text(p.get("value") ?? p.get("id") ?? p.get("label") ?? p.get("title")) ?? String(i);
          while (seen.has(value)) value += "'";
          seen.add(value);
          panel.data!.hProperties = { dataValue: value };
          return {
            value,
            label: text(p.get("label") ?? p.get("title") ?? p.get("value") ?? p.get("id")) ?? `Tab ${i + 1}`,
            isDefault: p.get("default") === true,
          };
        });
      const chosen = text(props.get("defaultActiveId") ?? props.get("defaultValue") ?? props.get("defaultTab"));
      const first = tabs.find((t) => t.value === chosen) ?? tabs.find((t) => t.isDefault) ?? tabs[0];
      out = box("mdx-tabs", children, { dataTabs: JSON.stringify(tabs.map(({ value, label }) => ({ value, label }))), dataDefault: first?.value });
      break;
    }
    case "steps": {
      let n = 0;
      for (const c of children) if (c.kind === "step") c.data!.hProperties!.dataIndex = String(++n);
      out = box("mdx-steps", children);
      break;
    }
    case "details": {
      // The summary goes first, where <details> wants it; without one, a plain "Details".
      const at = children.findIndex((c) => c.kind === "summary");
      if (at > 0) children.unshift(...children.splice(at, 1));
      if (at < 0) children.unshift({ ...box("mdx-summary", [{ type: "text", value: "Details" }]), kind: "summary" });
      out = box("mdx-details", children);
      break;
    }
    case "card": {
      const href = text(props.get("href"));
      out = box("mdx-card", children, { dataTitle: text(props.get("title")), dataHref: href && isWebUrl(href) ? href : undefined });
      break;
    }
    case "step":
      out = box("mdx-step", children, { dataTitle: text(props.get("title")) });
      break;
    default:
      // tab, summary, cards: drawn by their kind alone.
      out = box(`mdx-${kind}`, children);
  }
  out.kind = kind;
  out.props = props;
  return [out];
}

/** The components the boxes draw as (Markdown's own `a` and `img` come from components/markdown.tsx). */
export const MDX_COMPONENTS = {
  "mdx-admonition": Admonition,
  "mdx-tabs": MdxTabs,
  "mdx-tab": MdxTab,
  "mdx-details": MdxDetails,
  "mdx-summary": MdxSummary,
  "mdx-steps": MdxSteps,
  "mdx-step": MdxStep,
  "mdx-cards": MdxCards,
  "mdx-card": MdxCard,
  "mdx-unknown": Unknown,
  "mdx-unknown-inline": UnknownInline,
};

const plugins = (indentedCode: boolean) => [[remarkMdxSyntax, { indentedCode }], remarkGfm, remarkMdxAsData] as Options["remarkPlugins"];
const WITH_INDENTED_CODE = plugins(true);
const WITHOUT_INDENTED_CODE = plugins(false);

// ── Parsing, with repairs ───────────────────────────────────────────────────

/** The offset of `line:column` (1-based) in `src`. */
function offsetOf(src: string, line: number, column: number): number {
  let at = 0;
  for (let l = 1; l < line; l++) at = src.indexOf("\n", at) + 1;
  return at + column - 1;
}

/**
 * `src` changed so that the error `e` won't happen again, or null if it can't be.
 * A tag left open is closed at the end; otherwise the `<` that started the bad
 * construct is escaped, so it shows as text.
 */
function repair(src: string, e: unknown, tried: Set<string>): string | null {
  const err = e as { message?: string; line?: number; column?: number };
  const message = String(err.message ?? e);
  const open = /^Expected a closing tag for `<([^>\s]*)>`/.exec(message);
  if (open && !tried.has(message)) {
    tried.add(message);
    return `${src}\n</${open[1]}>`;
  }
  const where = /\((\d+):(\d+)-/.exec(message);
  const line = where ? Number(where[1]) : err.line;
  const column = where ? Number(where[2]) : err.column;
  if (!line || !column) return null;
  for (let i = Math.min(offsetOf(src, line, column), src.length - 1); i >= 0; i--) {
    if (src[i] === "<" && src[i - 1] !== "\\") return `${src.slice(0, i)}\\${src.slice(i)}`;
  }
  return null;
}

/**
 * One block of prepared text (lib/mdx.ts) as React elements; never throws. An
 * element a streaming reply hasn't closed yet is closed, and a block that still
 * won't parse is repaired a few times (see `repair`). Past that, every `<` in it
 * is shown as text, and if even that fails, the whole block is.
 */
export function renderMdx(src: string, components: Components): ReactNode {
  const { open, flow } = scanJsx(src);
  const remarkPlugins = flow ? WITHOUT_INDENTED_CODE : WITH_INDENTED_CODE;
  const parse = (children: string) => ReactMarkdown({ children, remarkPlugins, components });
  const tried = new Set<string>();
  // Closed up front: one parse, not a failed one and a repair.
  let text =
    src +
    open
      .reverse()
      .map((name) => `\n</${name}>`)
      .join("");
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      return parse(text);
    } catch (e) {
      const next = repair(text, e, tried);
      if (next === null) break;
      text = next;
    }
  }
  try {
    return parse(prepareMdx(src, { jsx: false }));
  } catch {
    return createElement("p", null, src);
  }
}
