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
import { useEffect, useId, useState } from "react";
import mermaid from "mermaid";
import { ErrorText } from "@/components/error-text";
import { keepLinksOutside } from "@/components/ui-blocks/links";
import { stripRemoteResources } from "@/components/ui-blocks/svg-clean";
import { errorMessage } from "@/lib/narrow";

let theme: string | null = null;
function setup() {
  // Follow the app's theme, so agent diagrams stay legible in dark mode.
  const next = document.documentElement.classList.contains("dark") ? "dark" : "neutral";
  if (theme === next) return;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: next, fontFamily: "inherit" });
  theme = next;
}

type Drawn = { text: string; svg: string } | { text: string; error: string };

export default function UiDiagram({ text }: { text: string }) {
  const id = "d" + useId().replace(/[^a-zA-Z0-9]/g, "");
  // Keyed by the text it was drawn from, so a new text never shows an old error.
  const [drawn, setDrawn] = useState<Drawn | null>(null);

  useEffect(() => {
    let stale = false;
    setup();
    mermaid.render(id, text).then(
      ({ svg }) => !stale && setDrawn({ text, svg: stripRemoteResources(svg) }),
      (e: unknown) => !stale && setDrawn({ text, error: errorMessage(e) }),
    );
    return () => {
      stale = true;
    };
  }, [id, text]);

  if (drawn && drawn.text === text && "error" in drawn)
    return (
      <div className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2">
        <ErrorText error={`Diagram didn't parse: ${drawn.error.split("\n")[0]}`} />
        <pre className="overflow-x-auto font-mono text-xs text-muted-foreground">{text}</pre>
      </div>
    );
  // While a new text draws, the previous diagram stays up instead of flashing a placeholder.
  if (!drawn || !("svg" in drawn)) return <div className="h-40 animate-pulse rounded-md bg-muted" />;
  return (
    <div
      className="overflow-x-auto [&_svg]:mx-auto [&_svg]:max-w-full"
      onClickCapture={keepLinksOutside}
      onAuxClickCapture={keepLinksOutside}
      // Mermaid's output in strict mode, sanitised by its DOMPurify, then stripped of anything that fetches (see above).
      dangerouslySetInnerHTML={{ __html: drawn.svg }}
    />
  );
}
