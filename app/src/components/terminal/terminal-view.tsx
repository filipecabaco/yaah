// One view of a terminal Rust runs (terminals.rs): it attaches over a channel, draws
// the bytes with the terminal engine (engine.ts), acknowledges what it drew so a fast
// program waits for it, sends keys and its size back for a shell pane, and follows the
// app's theme. A read-only view (a tool card) only shows output. The engine is loaded
// on first use; the view knows nothing about xterm.js.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { runShortcut } from "@/hooks/use-shortcuts";
import { openExternal } from "@/lib/links";
import { terminalShortcut } from "@/lib/shortcuts";
import { frameBytes, terminalApi, type TerminalAttached, type TerminalExit, type TerminalFrame } from "@/lib/terminal-api";
import { cn } from "@/lib/utils";
import { loadEngine, type TerminalEngine } from "./engine";
import { onThemeChange, readTerminalFont, readTerminalTheme } from "./theme";

/** Acknowledge at least this often (bytes drawn), so Rust's reader never waits long. */
const ACK_EVERY = 64 << 10;

export type TerminalViewProps = {
  /** The terminal to show (`terminal_open`'s id, or an agent's `terminalId`). */
  terminalId: string;
  /** Keys and size go to the program (a shell pane). */
  interactive: boolean;
  /** WebGL for panes; tool cards use the DOM renderer (many of them, mostly idle). */
  renderer?: "webgl" | "dom";
  /** Fixed at the PTY's size instead of fitting (a tool card). */
  fixedSize?: boolean;
  autoFocus?: boolean;
  /** Bytes to show when the terminal is gone from Rust (a released agent terminal after a restart). */
  replay?: Uint8Array | null;
  scrollback?: number;
  /** At the default code size; Settings → Fonts scales it (theme.ts `readTerminalFont`). */
  fontSize?: number;
  className?: string;
  onAttached?: (info: TerminalAttached) => void;
  onExit?: (exit: TerminalExit) => void;
  /** Rust has no such terminal and there was nothing to replay. */
  onGone?: (why: string) => void;
  /** Called with the engine once it draws (tests; the pane's search). */
  onEngine?: (engine: TerminalEngine | null) => void;
};

export function TerminalView({
  terminalId,
  interactive,
  renderer = "webgl",
  fixedSize = false,
  autoFocus = false,
  replay,
  scrollback = 5000,
  fontSize = 12,
  className,
  onAttached,
  onExit,
  onGone,
  onEngine,
}: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null);
  // Latest callbacks, so a parent's re-render doesn't re-attach.
  const cb = useRef({ onAttached, onExit, onGone, onEngine, replay, autoFocus });
  useLayoutEffect(() => {
    cb.current = { onAttached, onExit, onGone, onEngine, replay, autoFocus };
  });
  // The pane taking the focus later moves the keyboard in; the terminal isn't made again.
  const engineRef = useRef<TerminalEngine | null>(null);
  useEffect(() => {
    if (autoFocus) engineRef.current?.focus();
  }, [autoFocus]);
  const [clip, setClip] = useState<{ text: string; answer: (ok: boolean) => void } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // "Always in this terminal" for OSC 52 copies.
  const allowClipboard = useRef(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let engine: TerminalEngine | null = null;
    let disposed = false;
    let viewer: number | null = null;
    let unacked = 0;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    // Frames that arrive before the engine is up.
    const early: TerminalFrame[] = [];

    const ack = (n: number) => {
      unacked += n;
      if (viewer == null) return;
      const send = () => {
        ackTimer = null;
        const bytes = unacked;
        unacked = 0;
        if (bytes > 0 && viewer != null) terminalApi.ack(terminalId, viewer, bytes).catch(() => undefined);
      };
      if (unacked >= ACK_EVERY) send();
      else ackTimer ??= setTimeout(send, 50);
    };
    const apply = (f: TerminalFrame) => {
      if (!engine) return void early.push(f);
      const bytes = frameBytes(f);
      if (bytes) engine.write(bytes, () => ack(bytes.length));
      else if ("exit" in f) cb.current.onExit?.(f.exit);
    };

    const start = async () => {
      const factory = await loadEngine();
      if (disposed) return;
      let info: TerminalAttached | null = null;
      try {
        info = await terminalApi.attach(terminalId, apply);
      } catch (e) {
        const stored = cb.current.replay;
        if (!stored) {
          const why = String(e);
          setFailed(why);
          cb.current.onGone?.(why);
          return;
        }
        early.push(stored);
      }
      if (disposed) {
        if (info?.viewer) void terminalApi.detach(terminalId, info.viewer);
        return;
      }
      viewer = info?.viewer || null;
      const size = fixedSize ? { cols: info?.cols || 120, rows: info?.rows || 24 } : undefined;
      engine = factory(el, {
        interactive: interactive && !info?.agent,
        renderer,
        theme: readTerminalTheme(el),
        ...readTerminalFont(fontSize),
        scrollback,
        size,
        onData: (d) => void terminalApi.write(terminalId, d).catch((e: unknown) => console.error("terminal write", e)),
        onResize: (cols, rows) => {
          if (interactive && !info?.agent) void terminalApi.resize(terminalId, cols, rows).catch(() => undefined);
        },
        onClipboardWrite: (text) =>
          allowClipboard.current
            ? Promise.resolve(true)
            : new Promise<boolean>((resolve) =>
                setClip({
                  text,
                  answer: (ok) => {
                    setClip(null);
                    resolve(ok);
                  },
                }),
              ),
        passThrough: (e) => terminalShortcut(e) != null,
        onLink: openExternal,
      });
      if (info) cb.current.onAttached?.(info);
      cb.current.onEngine?.(engine);
      for (const f of early.splice(0)) apply(f);
      if (!fixedSize) {
        const changed = engine.fit();
        // The PTY takes the size the view has, even when fitting changed nothing (a re-attach).
        if (interactive && !info?.agent)
          void terminalApi.resize(terminalId, changed?.cols ?? engine.cols, changed?.rows ?? engine.rows).catch(() => undefined);
      }
      engineRef.current = engine;
      if (cb.current.autoFocus) engine.focus();
    };
    start().catch((e: unknown) => {
      console.error("terminal view", e);
      setFailed(String(e));
    });

    // Fit as the pane resizes; once a frame, however many resizes there were.
    let fitFrame = 0;
    const ro = new ResizeObserver(() => {
      if (fixedSize || fitFrame) return;
      fitFrame = requestAnimationFrame(() => {
        fitFrame = 0;
        engine?.fit();
      });
    });
    ro.observe(el);
    // The theme and the fonts are both variables on the root: a change to either redraws, and a new
    // code font or size changes the cell size, so the grid is fitted again (and the PTY told).
    const stopTheme = onThemeChange(() => {
      if (!engine) return;
      engine.setTheme(readTerminalTheme(el));
      const font = readTerminalFont(fontSize);
      if (engine.setFont(font.fontFamily, font.fontSize) && !fixedSize) engine.fit();
    });
    // Keys the terminal leaves to the app run here; the rest stay in the terminal (the app never sees ⌘N or Ctrl+L).
    const onKey = (e: KeyboardEvent) => {
      const hit = terminalShortcut(e);
      e.stopPropagation();
      if (hit && !e.isComposing) {
        e.preventDefault();
        runShortcut(hit);
      }
    };
    el.addEventListener("keydown", onKey);

    return () => {
      disposed = true;
      ro.disconnect();
      stopTheme();
      el.removeEventListener("keydown", onKey);
      if (fitFrame) cancelAnimationFrame(fitFrame);
      if (ackTimer) clearTimeout(ackTimer);
      if (viewer != null) void terminalApi.detach(terminalId, viewer).catch(() => undefined);
      engine?.dispose();
      cb.current.onEngine?.(null);
      engine = null;
      engineRef.current = null;
    };
  }, [terminalId, interactive, renderer, fixedSize, scrollback, fontSize]);

  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-col", className)}>
      <div
        ref={host}
        data-terminal={terminalId}
        className="min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--terminal-background)] p-1.5 [&_.xterm]:h-full"
      />
      {failed && <p className="px-2 py-1 text-xs text-muted-foreground">This terminal isn't available: {failed}</p>}
      {clip && (
        <div role="alertdialog" aria-label="Copy to the clipboard?" className="flex flex-wrap items-center gap-2 border-t bg-muted px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">
            The program wants to copy {clip.text.length} characters to your clipboard:{" "}
            <span className="font-mono text-muted-foreground">{clip.text.length > 60 ? `${clip.text.slice(0, 60)}…` : clip.text}</span>
          </span>
          <Button size="xs" variant="outline" onClick={() => clip.answer(false)}>
            Don't allow
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              allowClipboard.current = true;
              clip.answer(true);
            }}
          >
            Always in this terminal
          </Button>
          <Button size="xs" onClick={() => clip.answer(true)}>
            Allow
          </Button>
        </div>
      )}
    </div>
  );
}
