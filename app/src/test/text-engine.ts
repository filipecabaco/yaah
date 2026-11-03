// A terminal engine for tests (components/terminal/engine.ts): the bytes as plain text
// in a <pre>, escape sequences dropped, and a textbox that turns keys into input the way
// a terminal does. It goes through the same interface as xterm.js, so the views, the
// shortcuts that pass through and the Rust protocol are what's tested.
import type { EngineFactory, TerminalEngine } from "@/components/terminal/engine";

/** Engines made so far, newest last, with the element each draws in. */
export const engines: { el: HTMLElement; engine: TerminalEngine; interactive: boolean }[] = [];

const KEYS: Record<string, string> = { Enter: "\r", Backspace: "\x7f", Tab: "\t", Escape: "\x1b", ArrowUp: "\x1b[A", ArrowDown: "\x1b[B" };

export const textEngine: EngineFactory = (el, o) => {
  const pre = document.createElement("pre");
  pre.dataset.terminalText = "";
  const input = document.createElement("textarea");
  input.setAttribute("aria-label", "Terminal input");
  input.readOnly = !o.interactive;
  el.append(pre, input);
  let text = "";
  const decoder = new TextDecoder();
  // Escape sequences (CSI) and backspaces, built from strings: a regex literal can't hold control characters here.
  const csi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
  const lines = new RegExp(`(\\r\\n|\\r|\\n|${String.fromCharCode(8)})`);
  const draw = (chunk: string) => {
    for (const part of chunk.replace(csi, "").split(lines)) {
      if (part === "\r\n" || part === "\n") text += "\n";
      else if (part === "\x08") text = text.slice(0, -1);
      else if (part !== "\r") text += part;
    }
    pre.textContent = text;
  };
  input.addEventListener("keydown", (e) => {
    if (o.passThrough(e)) return;
    if (!o.interactive) return;
    if (e.ctrlKey && !e.shiftKey && e.key.length === 1) o.onData(String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64));
    else if (KEYS[e.key]) o.onData(KEYS[e.key]);
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) o.onData(e.key);
    e.preventDefault();
  });
  let cols = o.size?.cols ?? 80;
  let rows = o.size?.rows ?? 24;
  const engine: TerminalEngine = {
    write(data, done) {
      draw(decoder.decode(data, { stream: true }));
      done?.();
    },
    fit: () => null,
    resize(c, r) {
      cols = c;
      rows = r;
    },
    focus: () => input.focus(),
    setTheme: () => undefined,
    search: (q) => text.includes(q),
    serialize: () => text,
    renderer: "other",
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },
    dispose() {
      pre.remove();
      input.remove();
    },
  };
  engines.push({ el, engine, interactive: o.interactive });
  return engine;
};
