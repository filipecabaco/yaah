// The terminal engine behind <TerminalView>: what draws a terminal's bytes and
// turns keys into input. One engine module implements it (xterm-engine.ts: xterm.js
// with WebGL, DOM as the fallback); another (libghostty) can replace it per pane type
// without touching the views, the Rust side (raw bytes out, input in, a size) or the tests.

/** Colours as `#rrggbb`, read from the app's CSS variables (theme.ts). */
export type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  /** The 16 ANSI colours: black, red, green, yellow, blue, magenta, cyan, white, then the bright ones. */
  ansi: string[];
};

export type EngineOptions = {
  /** Keys go to the program. A read-only view (a tool card) shows output only. */
  interactive: boolean;
  /** "webgl" falls back to "dom" when WebGL2 isn't there or its context is lost. */
  renderer: "webgl" | "dom";
  theme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
  /** Lines kept on screen-side scrollback (Rust keeps its own 256 KB for re-attaching). */
  scrollback: number;
  /** A fixed size (a tool card follows the PTY's); otherwise it fits its element. */
  size?: { cols: number; rows: number };
  /** Typed or pasted input, as the program should get it. */
  onData: (data: string) => void;
  /** The grid changed size (fit to its element). */
  onResize: (cols: number, rows: number) => void;
  /** A program asked to set the clipboard (OSC 52). Resolve true to allow it; never done silently. */
  onClipboardWrite: (text: string) => Promise<boolean>;
  /** Keys the engine leaves alone, so the app gets them (⌘K, ⌘D, ⌘W, ⌘T). */
  passThrough: (e: KeyboardEvent) => boolean;
  /** Links in the output open with this. */
  onLink: (url: string) => void;
};

export interface TerminalEngine {
  /** Draw bytes as printed; `done` runs once they're drawn (for the view's acknowledgement). Writes are batched per frame. */
  write(data: Uint8Array, done?: () => void): void;
  /** Fit the grid to its element; the new size, if it changed. */
  fit(): { cols: number; rows: number } | null;
  resize(cols: number, rows: number): void;
  focus(): void;
  setTheme(theme: TerminalTheme): void;
  /** Draw in another font or size (Settings → Fonts); true when it changed, so the view re-fits the grid. */
  setFont(fontFamily: string, fontSize: number): boolean;
  /** Find `query` from the current match on; false when there's none. */
  search(query: string, direction?: "next" | "previous"): boolean;
  /** The text on screen and in scrollback (for copy-all and tests). */
  serialize(): string;
  /** Which renderer draws it now. */
  readonly renderer: "webgl" | "dom" | "other";
  readonly cols: number;
  readonly rows: number;
  dispose(): void;
}

export type EngineFactory = (el: HTMLElement, options: EngineOptions) => TerminalEngine;

let override: EngineFactory | null = null;

/** Use another engine (tests; a future libghostty one). `null` goes back to xterm.js. */
export function setTerminalEngine(factory: EngineFactory | null) {
  override = factory;
}

/** The engine, loaded on first use: xterm.js is its own chunk. */
export async function loadEngine(): Promise<EngineFactory> {
  if (override) return override;
  return (await import("./xterm-engine")).createXtermEngine;
}
