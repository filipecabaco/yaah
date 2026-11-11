// The one Markdown renderer for agent text (chat replies and agent-built UI).
// Every text is read as MDX, made to read like plain Markdown where MDX differs
// (lib/mdx.ts), so Markdown draws as it always has and MDX (frontmatter, imports,
// `<Components>`) is drawn as data, never run (lib/mdx-render.ts).
// Agent and third-party text is untrusted, so:
// - no raw HTML: tags draw as yaah's components or a few plain elements, never
//   with their attributes; react-markdown's URL transform drops `javascript:`
//   and other unsafe schemes;
// - links never navigate the app's own webview: http(s) opens in the system
//   browser, anything else is inert text;
// - remote images don't load until clicked (no tracking pixels on render);
//   data: images show directly.
//
// Text is drawn block by block (lib/markdown-blocks.ts): each top-level block is
// parsed once and kept, so a streamed reply re-parses only its last block, and
// reopening a chat reuses blocks parsed before.
import { ResizeHandle } from "@/components/column-resize";
import { useColumnResize, type ColumnResize } from "@/hooks/use-column-resize";
import { COPY_CORNER_CODE, CopyButton } from "@/components/copy-button";
import { createContext, Fragment, memo, useContext, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageOff } from "lucide-react";
import { HighlightedLine } from "@/components/code-block";
import { detectLanguage } from "@/lib/language";
import { useTokens } from "@/lib/use-tokens";
import { hostOf, isWebUrl, openExternal } from "@/lib/links";
import { Lru } from "@/lib/lru";
import { mdxBlocks, prepareMdx, splitFrontmatter } from "@/lib/mdx";
import { MDX_COMPONENTS, renderMdx } from "@/lib/mdx-render";

function Link({ href, children }: ComponentProps<"a">) {
  if (!isWebUrl(href)) return <span className="underline decoration-dotted">{children}</span>;
  return (
    <a
      href={href}
      title={href}
      rel="noreferrer noopener"
      onClick={(e) => {
        e.preventDefault();
        openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

/** An image from untrusted content: `data:image/…` shows at once, http(s) after a click, anything else not at all. */
export function SafeImage({ src, alt, width, className }: { src: unknown; alt?: string; width?: number; className?: string }) {
  const [load, setLoad] = useState(false);
  const url = typeof src === "string" ? src : "";
  if (url.startsWith("data:image/") || (load && isWebUrl(url)))
    return (
      <img src={url} alt={alt ?? ""} width={width} loading="lazy" referrerPolicy="no-referrer" className={className ?? "max-w-full rounded-md"} />
    );
  if (!isWebUrl(url)) return null;
  return (
    <button
      type="button"
      onClick={() => setLoad(true)}
      className="inline-flex items-center gap-1.5 self-start rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
      title={url}
    >
      <ImageOff className="size-3.5" /> {alt ? `${alt} · ` : ""}load image from {hostOf(url)}
    </button>
  );
}

/**
 * An agent's `#` is a section of the chat, under the pane's own title (its h1): every heading goes
 * one level down (SR-5), so a reply's "# Release notes" isn't a second page title. `data-md` keeps
 * the level it was written at, which index.css sizes it by.
 */
function heading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${Math.min(6, level + 1)}` as "h2";
  return function Heading({ id, children }: ComponentProps<"h2">) {
    return (
      <Tag id={id} data-md={`h${level}`}>
        {children}
      </Tag>
    );
  };
}

/** The text of a fence's code: a string, or the pieces react-markdown made of it. */
const fenceText = (c: unknown): string | null =>
  typeof c === "string" ? c : Array.isArray(c) && c.every((x) => typeof x === "string") ? c.join("") : null;

function HighlightedFence({ text, className }: { text: string; className?: string }) {
  const lang = detectLanguage({ language: /(?:^|\s)language-(\S+)/.exec(className ?? "")?.[1], text });
  const tokens = useTokens(text, lang);
  return (
    <div data-code-copy className="group/code relative">
      <pre data-highlight={tokens ? (lang ?? "") : undefined}>
        <code className={className}>
          {tokens
            ? tokens.map((line, i) => (
                <Fragment key={i}>
                  {i > 0 && "\n"}
                  <HighlightedLine tokens={line} />
                </Fragment>
              ))
            : text}
        </code>
      </pre>
      <CopyButton text={text.replace(/\n$/, "")} label="Copy code" className={COPY_CORNER_CODE} />
    </div>
  );
}

/** A fenced code block: highlighted by the language on its fence (or what the text looks like), in the same `pre > code` as before. */
function Pre({ children }: ComponentProps<"pre">) {
  const code = (Array.isArray(children) ? children[0] : children) as { props?: { className?: string; children?: unknown } } | null;
  const text = fenceText(code?.props?.children);
  if (text == null) return <pre>{children}</pre>;
  return <HighlightedFence text={text} className={code?.props?.className} />;
}

// Tables: scroll sideways inside their own box instead of squeezing their columns, and the user can
// drag a column's edge (components/column-resize.tsx). The box and the handles are `data-md-table` /
// `data-col-resize`, so tests can read the table as plain Markdown draws it.
const TableResize = createContext<ColumnResize | null>(null);

function MdTable({ children }: ComponentProps<"table">) {
  const resize = useColumnResize();
  return (
    <div data-md-table className="md-table">
      <TableResize.Provider value={resize}>
        <table data-fixed={resize.widths ? "" : undefined} style={resize.tableStyle}>
          {children}
        </table>
      </TableResize.Provider>
    </div>
  );
}

function MdTh({ children, style, node: _node, ...props }: ComponentProps<"th"> & { node?: unknown }) {
  const resize = useContext(TableResize);
  const cell = useRef<HTMLTableCellElement>(null);
  const [index, setIndex] = useState(-1);
  // Which column this is: read from the DOM once the row exists (a header cell knows no index of its own).
  useLayoutEffect(() => setIndex(cell.current?.cellIndex ?? -1), []);
  const width = resize && index >= 0 ? resize.widthOf(index) : undefined;
  return (
    <th ref={cell} {...props} style={{ ...style, ...(width ? { width } : null) }}>
      {children}
      {resize && index >= 0 && <ResizeHandle resize={resize} index={index} label={`column ${index + 1}`} />}
    </th>
  );
}

const components: Components = {
  a: Link,
  pre: Pre,
  table: MdTable,
  th: MdTh,
  img: ({ src, alt }) => <SafeImage src={src} alt={alt} />,
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  ...MDX_COMPONENTS,
};

/** Parsed blocks by their text, across every message (React elements can be shown again anywhere). */
const parsed = new Lru<string, ReactNode>(2000);

/** One block's elements, from the cache or parsed now. */
const Block = memo(function Block({ text }: { text: string }) {
  let out = parsed.get(text);
  if (out === undefined) {
    // react-markdown's `Markdown` is a plain function of its options (no hooks), so its elements can be kept.
    out = renderMdx(text, components);
    parsed.set(text, out);
  }
  return out;
});

/** The text as drawn: its frontmatter, and the rest in blocks. */
function prepare(text: string, whole: boolean): { yaml: string | null; blocks: string[] } {
  const { yaml, body } = splitFrontmatter(text);
  const src = prepareMdx(body);
  return { yaml, blocks: whole ? [src] : mdxBlocks(src) };
}

/** Frontmatter: folded away, its YAML shown as text when opened. */
function Frontmatter({ yaml }: { yaml: string }) {
  const title = /^title:[ \t]*(["']?)(.+?)\1[ \t]*$/m.exec(yaml)?.[2];
  return (
    <details data-mdx="frontmatter" className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">Frontmatter{title && <span className="text-foreground"> · {title}</span>}</summary>
      <pre className="mt-1">
        <code>{yaml}</code>
      </pre>
    </details>
  );
}

function Rendered({ text, whole }: { text: string; whole: boolean }) {
  const doc = useMemo(() => prepare(text, whole), [text, whole]);
  return (
    <div className="markdown">
      {doc.yaml !== null && <Frontmatter yaml={doc.yaml} />}
      {doc.blocks.map((b, i) => (
        // The newline react-markdown puts between top-level blocks, so the DOM is the same as one whole render.
        <Fragment key={i}>
          {(i > 0 || doc.yaml !== null) && "\n"}
          <Block text={b} />
        </Fragment>
      ))}
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return <Rendered text={children} whole={false} />;
}

/** The whole text in one parse (tests compare the block-by-block output with it). */
export function WholeMarkdown({ children }: { children: string }) {
  return <Rendered text={children} whole />;
}

/** Raw HTML in plain text is text: `<Foo>` stays as typed, never a tag (react-markdown would drop it). */
function remarkHtmlAsText() {
  const walk = (node: { type: string; value?: string; children?: unknown[] }) => {
    if (node.type === "html") node.type = "text";
    for (const c of node.children ?? []) walk(c as typeof node);
  };
  return walk;
}

const PLAIN_PLUGINS = [remarkGfm, remarkHtmlAsText];
const { a, img, h1, h2, h3, h4, h5, h6 } = components;
const PLAIN_COMPONENTS: Components = { a, img, h1, h2, h3, h4, h5, h6 };

/**
 * What the user typed, as plain CommonMark + GFM (code, bold, lists, links, tables): no MDX and no
 * frontmatter, so `import x from "y"`, `<Foo>` and a leading `---` are not rewritten, and raw HTML is
 * shown as text, never rendered. Single line breaks are kept by `.user-message` (index.css).
 */
export function PlainMarkdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={PLAIN_PLUGINS} components={PLAIN_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
