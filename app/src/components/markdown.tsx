// The one markdown renderer for agent text (chat replies and agent-built UI).
// Agent and third-party text is untrusted, so:
// - no raw HTML: react-markdown escapes it (no rehype-raw), and its URL
//   transform already drops `javascript:` and other unsafe schemes;
// - links never navigate the app's own webview: http(s) opens in the system
//   browser, anything else is inert text;
// - remote images don't load until clicked (no tracking pixels on render);
//   data: images show directly.
import { useState, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ImageOff } from "lucide-react";
import { hostOf, isWebUrl, openExternal } from "@/lib/links";

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

const components: Components = {
  a: Link,
  img: ({ src, alt }) => <SafeImage src={src} alt={alt} />,
};
const plugins = [remarkGfm];

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
