// The xterm.js engine (engine.ts): xterm.js 6 with the WebGL2 renderer, falling back
// to xterm's DOM renderer when WebGL isn't available or its context is lost (as VS Code
// does). Loaded only when a terminal first shows, as its own chunk.
import { Terminal, type ITheme } from "@xterm/xterm";
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import type { EngineFactory, TerminalEngine, TerminalTheme } from "./engine";
import { isMac } from "@/lib/shortcuts";

const toXterm = (t: TerminalTheme): ITheme => {
  const [
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  ] = t.ansi;
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selectionBackground,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  };
};

export const createXtermEngine: EngineFactory = (el, o) => {
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: o.interactive,
    cursorStyle: o.interactive ? "block" : "bar",
    cursorInactiveStyle: o.interactive ? "outline" : "none",
    disableStdin: !o.interactive,
    fontFamily: o.fontFamily,
    fontSize: o.fontSize,
    lineHeight: 1.15,
    scrollback: o.scrollback,
    theme: toXterm(o.theme),
    macOptionIsMeta: false,
    macOptionClickForcesSelection: true,
    drawBoldTextInBrightColors: false,
    ...(o.size ? { cols: Math.max(2, o.size.cols), rows: Math.max(1, o.size.rows) } : {}),
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_e, uri) => o.onLink(uri)));
  // OSC 52: a program may ask to set the clipboard, only with the user's say-so; it never reads it.
  const clipboard: IClipboardProvider = {
    readText: () => "",
    writeText: async (_sel, text) => {
      if (await o.onClipboardWrite(text)) await navigator.clipboard.writeText(text);
    },
  };
  term.loadAddon(new ClipboardAddon(undefined, clipboard));
  term.open(el);
  try {
    term.loadAddon(new UnicodeGraphemesAddon());
    term.unicode.activeVersion = "15-graphemes";
  } catch {
    // Older widths: emoji sequences may take two cells too many.
  }

  let renderer: TerminalEngine["renderer"] = "dom";
  if (o.renderer === "webgl") {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        renderer = "dom";
      });
      term.loadAddon(webgl);
      renderer = "webgl";
    } catch {
      renderer = "dom";
    }
  }

  term.attachCustomKeyEventHandler((e) => {
    if (o.passThrough(e)) return false;
    // Shift+Enter is a newline that doesn't submit: xterm.js sends the same \r as Enter, so a program that
    // listens for it (Claude Code, Codex, OpenCode) never sees the difference. A line feed (Ctrl+J) is what
    // they all take as "newline", and a plain shell reads it as Enter. preventDefault: the keypress would send \r too.
    if (o.interactive && e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing) {
      if (e.type === "keydown") o.onData("\n");
      e.preventDefault();
      return false;
    }
    // Copy with a selection; otherwise ⌘C is nothing to a shell on macOS (and Ctrl+Shift+C on Linux).
    const copy = e.type === "keydown" && e.code === "KeyC" && (isMac ? e.metaKey : e.ctrlKey && e.shiftKey);
    if (copy && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection()).catch((err: unknown) => console.error("copy failed", err));
      e.preventDefault();
      return false;
    }
    // Paste is the browser's paste event, which xterm handles (bracketed when the program asks).
    if (e.type === "keydown" && e.code === "KeyV" && (isMac ? e.metaKey : e.ctrlKey && e.shiftKey)) return false;
    return true;
  });
  const subs = [term.onData((d) => o.interactive && o.onData(d)), term.onResize(({ cols, rows }) => o.onResize(cols, rows))];

  // Writes collected over a frame go to xterm as one.
  let queue: Uint8Array[] = [];
  let dones: (() => void)[] = [];
  let frame = 0;
  const flush = () => {
    frame = 0;
    const parts = queue;
    const after = dones;
    queue = [];
    dones = [];
    const size = parts.reduce((n, p) => n + p.length, 0);
    const all = parts.length === 1 ? parts[0] : new Uint8Array(size);
    if (parts.length > 1) {
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.length;
      }
    }
    term.write(all, () => after.forEach((f) => f()));
  };
  let disposed = false;

  return {
    write(data, done) {
      if (disposed) return;
      queue.push(data);
      if (done) dones.push(done);
      if (!frame) frame = requestAnimationFrame(flush);
    },
    fit() {
      if (o.size) return null;
      const before = { cols: term.cols, rows: term.rows };
      const d = fit.proposeDimensions();
      if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows) || d.cols < 2 || d.rows < 1) return null;
      fit.fit();
      return term.cols !== before.cols || term.rows !== before.rows ? { cols: term.cols, rows: term.rows } : null;
    },
    resize(cols, rows) {
      term.resize(Math.max(2, cols), Math.max(1, rows));
    },
    focus: () => term.focus(),
    setTheme(t) {
      term.options.theme = toXterm(t);
    },
    setFont(family, size) {
      if (term.options.fontFamily === family && term.options.fontSize === size) return false;
      // xterm measures the new cell size itself; the view fits the grid to it.
      term.options.fontFamily = family;
      term.options.fontSize = size;
      return true;
    },
    search: (q, dir = "next") => (dir === "next" ? search.findNext(q) : search.findPrevious(q)),
    serialize() {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      while (lines.length && !lines[lines.length - 1]) lines.pop();
      return lines.join("\n");
    },
    get renderer() {
      return renderer;
    },
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      for (const f of dones) f();
      subs.forEach((s) => s.dispose());
      term.dispose();
    },
  };
};
