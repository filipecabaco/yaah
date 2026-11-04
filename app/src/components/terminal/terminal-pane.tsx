// A terminal pane: the user's login shell in a folder, inside yaah. The pane's content
// is `{ kind: "terminal", cwd, id }` (layout.ts, saved with the layout). A pane that
// comes back after a restart names a shell that's gone, so it opens a new one in the
// same folder and says so; processes don't outlive the app.
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, RotateCcw, SquareTerminal, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { compactPath } from "@/lib/format";
import type { Selection } from "@/lib/layout";
import { openInTerminalApp, terminalApi, type TerminalExit } from "@/lib/terminal-api";
import { TerminalView } from "./terminal-view";

type TerminalContent = Extract<Selection, { kind: "terminal" }>;

/** One open per pane at a time (React may run the effect twice). */
const opening = new Map<string, Promise<{ id: string; cwd: string }>>();

export const RESTARTED_NOTE = "New shell, the previous session ended when yaah quit.";

/**
 * The grid a pane of this size holds, a little under (a shell that starts wider than its view
 * wraps its first prompt). The view fits it exactly once it draws.
 */
function gridFor(el: HTMLElement | null): { cols: number; rows: number } {
  const w = el?.clientWidth ?? 0;
  const h = el?.clientHeight ?? 0;
  if (!w || !h) return { cols: 80, rows: 24 };
  return { cols: Math.max(20, Math.floor((w - 16) / 7.6)), rows: Math.max(5, Math.floor((h - 90) / 15)) };
}

function openShell(pane: string, cwd: string | undefined, size: { cols: number; rows: number }) {
  let p = opening.get(pane);
  if (!p) {
    // A first size; the view fits it to the pane as soon as it draws.
    p = terminalApi.open(cwd ?? null, size.cols, size.rows).finally(() => setTimeout(() => opening.delete(pane), 0));
    opening.set(pane, p);
  }
  return p;
}

/** A shell that ends sooner than this after its pane attached failed to start: its pane stays open. */
export const QUICK_EXIT_MS = 1000;

export function TerminalPane({
  pane,
  content,
  focused,
  onContent,
  onClose,
}: {
  pane: string;
  content: TerminalContent;
  focused: boolean;
  /** The pane now shows this (its shell's id once it's open). */
  onContent: (c: TerminalContent) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exit, setExit] = useState<TerminalExit | null>(null);
  const [title, setTitle] = useState("shell");
  const latest = useRef({ content, onContent, onClose });
  // When this pane's view attached to its shell: an exit soon after is a failed start, not the user's `exit`.
  const attachedAt = useRef<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    latest.current = { content, onContent, onClose };
  });

  const launch = useCallback(() => {
    openShell(pane, latest.current.content.cwd, gridFor(box.current)).then(
      (opened) => latest.current.onContent({ kind: "terminal", cwd: opened.cwd, id: opened.id }),
      (e: unknown) => setError(String(e)),
    );
  }, [pane]);
  const start = (why: string | null) => {
    setError(null);
    setExit(null);
    setNote(why);
    launch();
  };

  // No shell yet: open one.
  useEffect(() => {
    if (!content.id) launch();
  }, [content.id, launch]);

  const restart = () => {
    setExit(null);
    if (content.id) void terminalApi.close(content.id);
    latest.current.onContent({ kind: "terminal", cwd: content.cwd });
  };

  const cwd = content.cwd ?? "";
  return (
    <div ref={box} className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--terminal-background)]">
      <header data-tauri-drag-region="deep" className="flex shrink-0 items-center gap-2 border-b bg-background px-4 py-2.5 text-sm">
        <SquareTerminal className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="shrink-0 font-medium">{title}</span>
        {exit && (
          <Badge variant="secondary" className="shrink-0 text-muted-foreground">
            {exit.signal ? `ended (${exit.signal})` : `exited ${exit.exitCode ?? ""}`}
          </Badge>
        )}
        <span className="ml-auto min-w-0 truncate font-mono text-xs text-muted-foreground" title={cwd}>
          {cwd ? compactPath(cwd) : ""}
        </span>
        {cwd && (
          <Button
            size="icon-xs"
            variant="ghost"
            title="Open this folder in your terminal app"
            aria-label="Open in terminal app"
            onClick={() => openInTerminalApp(cwd)}
          >
            <ExternalLink />
          </Button>
        )}
        <Button size="icon-xs" variant="ghost" title="Close the pane" aria-label="Close terminal pane" onClick={onClose}>
          <X />
        </Button>
      </header>
      {note && (
        <p role="status" className="flex shrink-0 items-center gap-2 border-b bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{note}</span>
          <Button size="xs" variant="ghost" onClick={() => setNote(null)}>
            Dismiss
          </Button>
        </p>
      )}
      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-sm">
          <p className="max-w-md text-center text-muted-foreground">Couldn't start a shell: {error}</p>
          <Button variant="outline" size="sm" onClick={() => start(null)}>
            <RotateCcw /> Try again
          </Button>
        </div>
      ) : content.id ? (
        <TerminalView
          key={content.id}
          terminalId={content.id}
          interactive
          autoFocus={focused}
          className="flex-1"
          onAttached={(info) => {
            setTitle(info.title);
            attachedAt.current = Date.now();
            // Already over when this view attached (e.g. after a restart): say so rather than vanish.
            if (info.exit) setExit(info.exit);
          }}
          onExit={(e) => {
            // The shell ended while it was being shown (`exit`, Ctrl-D, a killed shell): close the pane,
            // as terminal apps do. One that died right after starting keeps the bar, so its error stays readable.
            const ranFor = attachedAt.current === null ? 0 : Date.now() - attachedAt.current;
            if (ranFor >= QUICK_EXIT_MS) latest.current.onClose();
            else setExit(e);
          }}
          onGone={() => start(RESTARTED_NOTE)}
        />
      ) : (
        <div className="flex-1" aria-busy="true" />
      )}
      {exit && (
        <div className="flex shrink-0 items-center gap-2 border-t bg-background px-3 py-1.5 text-xs text-muted-foreground">
          <span className="flex-1">The shell has exited.</span>
          <Button size="xs" variant="outline" onClick={restart}>
            <RotateCcw /> New shell
          </Button>
          <Button size="xs" variant="ghost" onClick={onClose}>
            Close pane
          </Button>
        </div>
      )}
    </div>
  );
}
