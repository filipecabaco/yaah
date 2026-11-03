// Typed bindings to the terminal commands (src-tauri/src/terminal_commands.rs, terminals.rs).
// A view attaches with a Tauri channel: raw PTY bytes arrive as ArrayBuffers, the
// end as `{ exit }`. It acknowledges what it has drawn, so a fast program waits for it.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** ACP's `TerminalExitStatus`. */
export type TerminalExit = { exitCode: number | null; signal: string | null };

/** What a view learns when it attaches (terminals.rs `Attached`). */
export type TerminalAttached = {
  id: string;
  viewer: number;
  cwd: string;
  /** The shell's name, or an agent's command line. */
  title: string;
  /** An agent's command: read-only here. */
  agent: boolean;
  cols: number;
  rows: number;
  /** Set once it has ended. */
  exit: TerminalExit | null;
  /** False for a released agent terminal replayed from what yaah kept. */
  live: boolean;
};

export type TerminalOpened = { id: string; cwd: string; title: string };

/** A frame on a view's channel. */
export type TerminalFrame = ArrayBuffer | Uint8Array | number[] | { exit: TerminalExit };

export const terminalApi = {
  /** A shell pane's login shell, in `cwd` (else the last folder one opened in, or home). */
  open: (cwd: string | null, cols: number, rows: number) => invoke<TerminalOpened>("terminal_open", { cwd, cols, rows, shell: null }),
  attach: (id: string, onFrame: (f: TerminalFrame) => void) => {
    const channel = new Channel<TerminalFrame>(onFrame);
    return invoke<TerminalAttached>("terminal_attach", { id, channel });
  },
  detach: (id: string, viewer: number) => invoke<void>("terminal_detach", { id, viewer }),
  ack: (id: string, viewer: number, bytes: number) => invoke<void>("terminal_ack", { id, viewer, bytes }),
  write: (id: string, data: string) => invoke<void>("terminal_write", { id, data }),
  resize: (id: string, cols: number, rows: number) => invoke<void>("terminal_resize", { id, cols, rows }),
  /** A shell pane's shell; an agent's terminal is left to its agent. */
  close: (id: string) => invoke<void>("terminal_close", { id }),
  /** Stop the program (a tool card's Stop); the terminal stays readable. */
  kill: (id: string) => invoke<void>("terminal_kill", { id }),
  defaultDir: () => invoke<string>("terminal_default_dir"),
  /** "Open in terminal": the user's own terminal app, in `dir`. */
  openInTerminalApp: (dir: string) => invoke<void>("open_in_terminal", { dir }),
  setTerminalApp: (id: string) => invoke<void>("set_terminal_app", { id }),
  onExit: (cb: (e: TerminalExit & { id: string }) => void) => listen<TerminalExit & { id: string }>("terminal-exit", (e) => cb(e.payload)),
};

/** "Open in terminal", logging what fails (a folder that went away, no terminal app). */
export function openInTerminalApp(dir: string) {
  terminalApi.openInTerminalApp(dir).catch((e: unknown) => console.error("could not open a terminal in", dir, e));
}

/** A channel frame's bytes, or null for the `{ exit }` frame. */
export function frameBytes(f: TerminalFrame): Uint8Array | null {
  if (f instanceof ArrayBuffer) return new Uint8Array(f);
  if (f instanceof Uint8Array) return f;
  if (Array.isArray(f)) return Uint8Array.from(f);
  return null;
}

/** Base64 (a released terminal's bytes kept with its tool call) to bytes. */
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
