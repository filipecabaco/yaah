// MDX drawn as data (loaded only when a text looks like MDX; see lib/mdx.ts).
// The MDX syntax is parsed (micromark-extension-mdx, which knows no JavaScript)
// and turned into plain Markdown nodes and boxes for a few of yaah's own
// components (components/mdx-components.tsx). No expression, attribute or
// import is ever evaluated: there is no compiler here.
// - a small set of docs components map onto the app's primitives: admonitions
//   (`Admonition`, `Callout`, `Note`, `Tip`, `Info`, `Warning`, `Caution`,
//   `Danger`) to an alert, `Tabs` with `TabPanel`/`Tab`/`TabItem` to tabs,
//   `details`/`summary`, `Steps`/`Step`, `Cards`/`Card`, and `img`/`Image` to the
//   same image as Markdown's (remote ones wait for a click);
// - plain HTML elements draw as themselves, without their attributes;
// - any other component shows its children in a quiet box labelled with its name;
// - props are only ever string, number or boolean literals; other attribute
//   expressions are dropped, and `{expressions}` in text show as code.
import type { ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { mdx } from "micromark-extension-mdx";
import { mdxJsxFromMarkdown } from "mdast-util-mdx-jsx";
import { mdxExpressionFromMarkdown } from "mdast-util-mdx-expression";
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
import { openTags } from "@/lib/mdx";

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

/** Syntax only: MDX's JSX and `{…}` (no JavaScript parser, so nothing is even read as code). */
function remarkMdxSyntax(this: { data(): object }) {
  const data = this.data() as { micromarkExtensions?: unknown[]; fromMarkdownExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push(mdx());
  (data.fromMarkdownExtensions ??= []).push(mdxJsxFromMarkdown(), mdxExpressionFromMarkdown());
}

/** MDX nodes into Markdown nodes and boxes for the components below. */
function remarkMdxAsData() {
  return (tree: Node) => {
    tree.children = convert(tree.children ?? []);
  };
}

const ADMONITIONS = new Set(["Admonition", "Callout", "Note", "Tip", "Info", "Warning", "Caution", "Danger", "Important"]);
// Maps, not objects: a tag or prop named `constructor` or `__proto__` must find nothing.
const KINDS = new Map([
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
/** What each container lifts out of a paragraph of its own (a one-line `<Tab>…</Tab>`). */
const CHILD_KIND = new Map([
  ["tabs", "tab"],
  ["details", "summary"],
  ["steps", "step"],
  ["cards", "card"],
]);
/** HTML elements drawn as themselves, with no attributes. */
const HTML = new Map([
  ..."kbd sub sup mark u small abbr ul ol li table thead tbody tr th td blockquote h1 h2 h3 h4 h5 h6 hr br p pre code figure figcaption strong em del"
    .split(" ")
    .map((t): [string, string] => [t, t]),
  ["b", "strong"],
  ["i", "em"],
  ["s", "del"],
]);
/** Wrappers whose children are shown in their place. */
const TRANSPARENT = new Set(["", "div", "span", "section", "article", "main", "header", "footer", "center", "Fragment"]);

function convert(nodes: Node[]): Node[] {
  return nodes.flatMap((node): Node[] => {
    switch (node.type) {
      case "mdxFlowExpression":
      case "mdxTextExpression": {
        const value = node.value ?? "";
        // `{/* a comment */}` is MDX's comment: nothing to show.
        if (!value.trim() || /^\s*\/\*[\s\S]*\*\/\s*$/.test(value)) return [];
        const code: Node = { type: "inlineCode", value: `{${value}}` };
        return [node.type === "mdxFlowExpression" ? { type: "paragraph", children: [code] } : code];
      }
      case "mdxJsxFlowElement":
      case "mdxJsxTextElement":
        return element(node, node.type === "mdxJsxFlowElement");
      case "mdxjsEsm":
        return [];
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

const MDX_COMPONENTS = {
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

const plugins = [remarkMdxSyntax, remarkGfm, remarkMdxAsData] as Options["remarkPlugins"];

// ── Parsing, with repairs ───────────────────────────────────────────────────

/** The offset of `line:column` (1-based) in `src`. */
function offsetOf(src: string, line: number, column: number): number {
  let at = 0;
  for (let l = 1; l < line; l++) at = src.indexOf("\n", at) + 1;
  return at + column - 1;
}

/**
 * `src` changed so that the error `e` won't happen again, or null if it can't be.
 * A tag left open (a reply still streaming) is closed at the end; otherwise the
 * `<` or `{` that started the bad construct is escaped, so it shows as text.
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
    if ((src[i] === "<" || src[i] === "{") && src[i - 1] !== "\\") return `${src.slice(0, i)}\\${src.slice(i)}`;
  }
  return null;
}

/**
 * One block of MDX as React elements. Malformed or partial MDX is repaired a few
 * times (see `repair`); past that this throws, and the caller draws plain Markdown.
 */
export function renderMdx(src: string, base: Components): ReactNode {
  const components = { ...base, ...MDX_COMPONENTS } as Components;
  const tried = new Set<string>();
  // Elements a streaming reply hasn't closed yet are closed up front (one parse, not a failed one and a repair).
  for (const name of openTags(src).reverse()) src += `\n</${name}>`;
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      return ReactMarkdown({ children: src, remarkPlugins: plugins, components });
    } catch (e) {
      const next = repair(src, e, tried);
      if (next === null) throw e;
      src = next;
    }
  }
  throw new Error("MDX could not be repaired");
}
