// Fake terminals (terminals.rs, terminal_commands.rs): a shell that echoes what's typed
// and runs `echo …` and `exit`, agents' commands that print on a timer until stopped,
// and "Open in terminal" calls recorded. Views attach over a channel and get bytes,
// as from Rust.
import type { Mock, Replies } from "./context";
import { home } from "./context";

type Channel = { onmessage: (m: unknown) => void };
type Exit = { exitCode: number | null; signal: string | null };
export type FakeTerminal = {
  id: string;
  cwd: string;
  title: string;
  agent: boolean;
  cols: number;
  rows: number;
  bytes: number[];
  viewers: Map<number, Channel>;
  exit: Exit | null;
  /** What's been typed on the current line (shells only). */
  line: string;
  timer?: ReturnType<typeof setInterval>;
};

export const TERMINAL_APPS = [
  { id: "system", label: "System default (Ghostty)" },
  { id: "ghostty", label: "Ghostty" },
  { id: "terminal", label: "Terminal" },
];

export function seedTerminals() {
  return {
    terminals: {} as Record<string, FakeTerminal>,
    /** Folders "Open in terminal" was asked to open, in order. */
    openedInTerminalApp: [] as string[],
    terminalApp: "system",
    lastTerminalDir: home,
    /** Every `terminal_write`, by terminal: what the keys sent. */
    terminalInput: {} as Record<string, string[]>,
  };
}

type TerminalState = ReturnType<typeof seedTerminals>;

let next = 1;
let nextViewer = 1;
const enc = new TextEncoder();

function send(t: FakeTerminal, text: string) {
  const b = enc.encode(text);
  t.bytes.push(...b);
  for (const ch of t.viewers.values()) ch.onmessage(b.slice().buffer);
}

function end(t: FakeTerminal, exit: Exit) {
  if (t.exit) return;
  clearInterval(t.timer);
  t.exit = exit;
  for (const ch of t.viewers.values()) ch.onmessage({ exit });
}

const PROMPT = "dev@yaah % ";

/** An agent's command, as `terminal/create` makes one: prints a line every `everyMs` until it's stopped. */
export function startAgentTerminal(
  state: TerminalState,
  {
    title,
    cwd = `${home}/workspace/shop`,
    lines = ["Compiling shop v0.4.0", "Running tests…"],
    everyMs = 20,
  }: { title: string; cwd?: string; lines?: string[]; everyMs?: number },
) {
  const id = `tagent${next++}`;
  const t: FakeTerminal = { id, cwd, title, agent: true, cols: 120, rows: 24, bytes: [], viewers: new Map(), exit: null, line: "" };
  state.terminals[id] = t;
  let i = 0;
  t.timer = setInterval(() => send(t, `\x1b[32m${lines[i++ % lines.length]}\x1b[0m\r\n`), everyMs);
  return t;
}

export function terminalReplies({ state }: Mock): Replies {
  const get = (id: string) => {
    const t = state.terminals[id];
    if (!t) throw new Error("that terminal has closed");
    return t;
  };
  return {
    terminal_open: ({ cwd, cols, rows }: { cwd: string | null; cols: number; rows: number }) => {
      const dir = cwd || state.lastTerminalDir;
      if (!dir.startsWith("/")) throw new Error(`${dir} isn't an absolute path`);
      state.lastTerminalDir = dir;
      const id = `tshell${next++}`;
      const t: FakeTerminal = { id, cwd: dir, title: "zsh", agent: false, cols, rows, bytes: [], viewers: new Map(), exit: null, line: "" };
      state.terminals[id] = t;
      send(t, PROMPT);
      return { id, cwd: dir, title: t.title };
    },
    terminal_attach: ({ id, channel }: { id: string; channel: Channel }) => {
      const t = get(id);
      const viewer = nextViewer++;
      if (t.bytes.length) channel.onmessage(Uint8Array.from(t.bytes).buffer);
      if (t.exit) channel.onmessage({ exit: t.exit });
      else t.viewers.set(viewer, channel);
      return { id, viewer, cwd: t.cwd, title: t.title, agent: t.agent, cols: t.cols, rows: t.rows, exit: t.exit, live: true };
    },
    terminal_detach: ({ id, viewer }: { id: string; viewer: number }) => {
      state.terminals[id]?.viewers.delete(viewer);
      return null;
    },
    terminal_ack: () => null,
    terminal_write: ({ id, data }: { id: string; data: string }) => {
      const t = get(id);
      if (t.agent) throw new Error("that terminal is an agent's; it's read-only here");
      (state.terminalInput[id] ??= []).push(data);
      for (const ch of data) {
        if (ch === "\r") {
          const cmd = t.line.trim();
          t.line = "";
          send(t, "\r\n");
          if (cmd === "exit") return void end(t, { exitCode: 0, signal: null });
          if (cmd.startsWith("echo ")) send(t, `${cmd.slice(5)}\r\n`);
          else if (cmd) send(t, `zsh: command not found: ${cmd.split(" ")[0]}\r\n`);
          send(t, PROMPT);
        } else if (ch === "\x7f") {
          t.line = t.line.slice(0, -1);
          send(t, "\b \b");
        } else if (ch >= " ") {
          t.line += ch;
          send(t, ch);
        }
      }
      return null;
    },
    terminal_resize: ({ id, cols, rows }: { id: string; cols: number; rows: number }) => {
      const t = get(id);
      if (t.agent) throw new Error("that terminal is an agent's; it's read-only here");
      t.cols = cols;
      t.rows = rows;
      return null;
    },
    terminal_close: ({ id }: { id: string }) => {
      const t = state.terminals[id];
      if (t && !t.agent) {
        end(t, { exitCode: null, signal: "SIGHUP" });
        delete state.terminals[id];
      }
      return null;
    },
    terminal_kill: ({ id }: { id: string }) => {
      end(get(id), { exitCode: null, signal: "SIGKILL" });
      return null;
    },
    terminal_default_dir: () => state.lastTerminalDir,
    open_in_terminal: ({ dir }: { dir: string }) => {
      if (!dir.startsWith("/")) throw new Error(`${dir} isn't an absolute path`);
      state.openedInTerminalApp.push(dir);
      return null;
    },
    set_terminal_app: ({ id }: { id: string }) => {
      if (!TERMINAL_APPS.some((a) => a.id === id)) throw new Error(`${id} isn't a terminal app yaah found`);
      state.terminalApp = id;
      return null;
    },
  };
}
