// A terminal pane: the user's login shell in a folder, inside yaah. The pane's content
// is `{ kind: "terminal", cwd, id, projectId }` (layout.ts, saved with the layout). A pane that
// comes back after a restart names a shell that's gone, so it opens a new one in the
// same folder and says so; processes don't outlive the app.
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Maximize2, Minimize2, RotateCcw, SquareTerminal, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { baseName, compactPath } from "@/lib/format";
import { addDropZone, type DragState } from "@/lib/attachments";
import { dropText } from "@/lib/shell-quote";
import { clearPaneInfo, setPaneInfo } from "@/lib/pane-info";
import type { Selection } from "@/lib/layout";
import { formatKeys, isMac, MOD, SHIFT, SHORTCUTS } from "@/lib/shortcuts";
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

/** ⌘⇧Enter (Ctrl+Shift+Enter on Linux), Ghostty's "zoom split": the terminal in a large dialog and back. */
const EXPAND_KEYS = [MOD, SHIFT, "Enter"];
const isExpandKey = (e: KeyboardEvent) => e.key === "Enter" && e.shiftKey && !e.altKey && (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

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
  const [expanded, setExpanded] = useState(false);
  const latest = useRef({ content, onContent, onClose });
  // When this pane's view attached to its shell: an exit soon after is a failed start, not the user's `exit`.
  const attachedAt = useRef<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    latest.current = { content, onContent, onClose };
  });

  // Files dropped from the OS (Tauri hands over real paths) and text dragged in are typed at the prompt,
  // paths escaped, nothing sent: the user presses Enter. The shell's own id is read at drop time.
  const [drag, setDrag] = useState<DragState | { text: true } | null>(null);
  const type = useCallback((text: string) => {
    const id = latest.current.content.id;
    if (id && text) void terminalApi.write(id, text).catch((e: unknown) => console.error("terminal drop", e));
  }, []);
  useEffect(() => {
    const el = box.current;
    return el ? addDropZone({ el, onDrag: setDrag, onDrop: (paths) => type(dropText(paths)) }) : undefined;
  }, [type]);

  const launch = useCallback(() => {
    openShell(pane, latest.current.content.cwd, gridFor(box.current)).then(
      // The folder the shell opened in, and its id; the project it belongs to stays.
      (opened) => latest.current.onContent({ ...latest.current.content, cwd: opened.cwd, id: opened.id }),
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
    latest.current.onContent({ kind: "terminal", cwd: content.cwd, projectId: content.projectId });
  };

  // A new shell starts its own clock (the quick-exit rule).
  useEffect(() => {
    attachedAt.current = null;
  }, [content.id]);

  /** The same shell, interactive, in the pane or in the expanded dialog (one view at a time). */
  const shellView = (id: string, autoFocus: boolean, className: string) => (
    <TerminalView
      key={id}
      terminalId={id}
      interactive
      autoFocus={autoFocus}
      className={className}
      onAttached={(info) => {
        setTitle(info.title);
        // The first view's attach starts the clock; moving to the dialog and back doesn't.
        attachedAt.current ??= Date.now();
        // Already over when this view attached (e.g. after a restart): say so rather than vanish.
        if (info.exit) setExit(info.exit);
      }}
      onExit={(e) => {
        // The shell ended while it was being shown (`exit`, Ctrl-D, a killed shell): close the pane,
        // as terminal apps do. One that died right after starting keeps the bar, so its error stays readable.
        const ranFor = attachedAt.current === null ? 0 : Date.now() - attachedAt.current;
        if (ranFor >= QUICK_EXIT_MS) {
          setExpanded(false);
          latest.current.onClose();
        } else setExit(e);
      }}
      onGone={() => start(RESTARTED_NOTE)}
    />
  );

  const cwd = content.cwd ?? "";
  // What the sidebar lists this pane as: its folder, and the shell's own title.
  useEffect(() => {
    setPaneInfo(pane, { title: cwd ? baseName(cwd) : title, detail: cwd ? title : undefined });
  }, [pane, cwd, title]);
  useEffect(() => () => clearPaneInfo(pane), [pane]);
  return (
    <div
      ref={box}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--terminal-background)]"
      // Text (a dragged selection, a link) in a plain DOM drag; files come through the drop zone above.
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("text/plain") || e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDrag((d) => (d && "items" in d ? d : { text: true }));
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag((d) => (d && "items" in d ? d : null));
      }}
      onDrop={(e) => {
        const text = e.dataTransfer.getData("text/plain");
        setDrag(null);
        if (!text || e.dataTransfer.files.length) return;
        e.preventDefault();
        type(text);
      }}
      // ⌘⇧Enter (Ctrl+Shift+Enter on Linux), Ghostty's "zoom split" keys: before the shell sees them.
      onKeyDownCapture={(e) => {
        if (!isExpandKey(e.nativeEvent) || !content.id) return;
        e.preventDefault();
        e.stopPropagation();
        setExpanded((x) => !x);
      }}
    >
      <header data-tauri-drag-region="deep" className="flex shrink-0 items-center gap-2 border-b bg-background px-4 py-2.5 text-sm">
        <SquareTerminal className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {/* Tab and Esc belong to the shell; the way out is said here (KB-2). */}
        <span
          className="shrink-0 font-medium"
          title={`Tab and Esc go to the shell. ${formatKeys(SHORTCUTS.focusPane.keys)} moves to the pane beside it`}
        >
          {title}
        </span>
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
        {content.id && !error && (
          <Button
            size="icon-xs"
            variant="ghost"
            title={`Expand (${formatKeys(EXPAND_KEYS)})`}
            aria-label="Expand terminal"
            aria-pressed={expanded}
            onClick={() => setExpanded(true)}
          >
            <Maximize2 />
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
      ) : content.id && expanded ? (
        // The dialog has the shell (its own view, sized to it); this pane gets it back on close.
        <div className="flex flex-1 items-center justify-center gap-3 text-sm text-muted-foreground">
          Shown expanded
          <Button size="xs" variant="outline" onClick={() => setExpanded(false)}>
            <Minimize2 /> Back to the pane
          </Button>
        </div>
      ) : content.id ? (
        shellView(content.id, focused, "flex-1")
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
      {drag && content.id && (
        <div
          role="status"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/70 ring-2 ring-ring ring-inset"
        >
          <span className="rounded-md border bg-background px-3 py-1.5 text-sm shadow-sm">
            {"items" in drag ? `Drop to type ${drag.items.length === 1 ? "its path" : `${drag.items.length} paths`} here` : "Drop to type this here"}
          </span>
        </div>
      )}
      <Dialog open={expanded && !!content.id} onOpenChange={setExpanded}>
        <DialogContent
          className="flex h-[92vh] w-[96vw] max-w-none flex-col gap-0 bg-[var(--terminal-background)] p-0 sm:max-w-none"
          // Esc belongs to the shell (vim, less, fzf): the X or ⌘⇧Enter closes this.
          onEscapeKeyDown={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onKeyDownCapture={(e) => {
            if (!isExpandKey(e.nativeEvent)) return;
            e.preventDefault();
            e.stopPropagation();
            setExpanded(false);
          }}
        >
          <div className="flex items-center gap-2 border-b bg-background px-4 py-2.5 pr-12 text-sm">
            <SquareTerminal className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <DialogTitle className="shrink-0 text-sm font-medium">{title}</DialogTitle>
            <DialogDescription className="ml-auto min-w-0 truncate font-mono text-xs text-muted-foreground" title={cwd}>
              {cwd ? compactPath(cwd) : "Terminal"} · {formatKeys(EXPAND_KEYS)} to go back
            </DialogDescription>
          </div>
          {content.id && expanded && shellView(content.id, true, "min-h-0 flex-1")}
        </DialogContent>
      </Dialog>
    </div>
  );
}
