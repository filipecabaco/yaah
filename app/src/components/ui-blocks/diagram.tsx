// `diagram` primitive — Mermaid (sequence, flowchart/network, ER, state, …). Loaded on demand.
// Agent-written diagram text can't run anything:
// - `securityLevel: "strict"` sanitises labels while drawing and passes the
//   finished SVG through Mermaid's DOMPurify; `%%{init}%%` directives can't
//   change `securityLevel` (a "secure" key) or the DOMPurify config;
// - click callbacks are never bound (strict ignores them, and `bindFunctions`
//   isn't called); `click … href` links go through Mermaid's URL sanitiser and,
//   when clicked, open in the system browser only if http(s);
// - user `style`/`classDef` CSS is compiled under the SVG's own id;
// - nothing in the finished SVG fetches: images and remote `url()`s are
//   stripped (svg-clean.ts), so a diagram can't send data out just by being drawn.
import { useEffect, useState } from "react";
import mermaid from "mermaid";
import { ErrorText } from "@/components/error-text";
import { DiagramCache, type Drawn } from "@/components/ui-blocks/diagram-cache";
import { keepLinksOutside } from "@/components/ui-blocks/links";
import { stripRemoteResources } from "@/components/ui-blocks/svg-clean";

let initialized: string | null = null;
/** Diagrams follow the app's theme, so agent diagrams stay legible in dark mode. */
const appTheme = () => (document.documentElement.classList.contains("dark") ? "dark" : "neutral");

// Every diagram is drawn once per theme; reopening a chat shows it from here.
const cache = new DiagramCache(async (id, text, theme) => {
  if (initialized !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme as "dark" | "neutral", fontFamily: "inherit" });
    initialized = theme;
  }
  const { svg } = await mermaid.render(id, text);
  return stripRemoteResources(svg);
});

export default function UiDiagram({ text }: { text: string }) {
  const theme = appTheme();
  const cached = cache.peek(theme, text);
  // Keyed by what it was drawn from, so a new text never shows an old error.
  const [drawn, setDrawn] = useState<{ theme: string; text: string; drawn: Drawn } | null>(null);

  useEffect(() => {
    if (cached) return;
    let stale = false;
    void cache.get(theme, text).then((d) => !stale && setDrawn({ theme, text, drawn: d }));
    return () => {
      stale = true;
    };
  }, [theme, text, cached]);

  const fresh = cached ?? (drawn && drawn.text === text && drawn.theme === theme ? drawn.drawn : null);
  if (fresh && "error" in fresh)
    return (
      <div className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2">
        <ErrorText error={`Diagram didn't parse: ${fresh.error.split("\n")[0]}`} />
        <pre className="overflow-x-auto font-mono text-xs text-muted-foreground">{text}</pre>
      </div>
    );
  // While a new text draws, the previous diagram stays up instead of flashing a placeholder.
  const svg = fresh?.svg ?? (drawn && "svg" in drawn.drawn ? drawn.drawn.svg : null);
  if (!svg) return <div className="h-40 animate-pulse rounded-md bg-muted" />;
  return (
    <div
      className="overflow-x-auto [&_svg]:mx-auto [&_svg]:max-w-full"
      onClickCapture={keepLinksOutside}
      onAuxClickCapture={keepLinksOutside}
      // Mermaid's output in strict mode, sanitised by its DOMPurify, then stripped of anything that fetches (see above).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
