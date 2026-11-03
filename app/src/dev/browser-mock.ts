// Dev-only: lets the UI run in a plain browser (`pnpm dev`, then open
// http://localhost:1420) by answering Rust commands with fixtures, and is the
// backend for the integration tests. Never loaded inside Tauri or in a
// production build. Each area lives in src/dev/mock/.
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { agentReplies } from "./mock/agents";
import { chatReplies, stopTurn } from "./mock/chats";
import type { Mock, Replies } from "./mock/context";
import { integrationReplies } from "./mock/integrations";
import { libraryReplies, pickFolder } from "./mock/library";
import { mcpReplies } from "./mock/mcp";
import { projectReplies } from "./mock/projects";
import { settingsReplies } from "./mock/settings";
import { skillReplies } from "./mock/skills";
import { sourceReplies } from "./mock/sources";
import { createState } from "./mock/state";
import { workItemReplies } from "./mock/work-items";
import { flushTranscripts } from "@/lib/transcripts";

export type BrowserMockOptions = {
  /** Multiplies every artificial wait (default 1). 0: no waiting, only a macrotask between events. */
  delay?: number;
  /** Start with no agents, for the first-run setup screen (default: `?first-run` in the URL). */
  firstRun?: boolean;
};

/** Stops the previous install's replays and timers, so a reinstall starts clean. */
let disposePrevious: (() => void) | undefined;

/**
 * Answers every command the UI invokes, from fresh state each time it is called.
 * Returns that state, so a test can set up what Rust would have (e.g. a transcript on disk).
 */
export function installBrowserMock(options: BrowserMockOptions = {}) {
  disposePrevious?.();
  const delay = options.delay ?? 1;
  const state = createState({ firstRun: options.firstRun ?? new URLSearchParams(location.search).has("first-run") });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const m: Mock = {
    state,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms * delay)),
    later: (ms, f) => {
      const t = setTimeout(() => (timers.delete(t), f()), ms * delay);
      timers.add(t);
    },
    emit: (event, payload) => emit(event, structuredClone(payload)),
  };
  disposePrevious = () => {
    for (const turn of Object.values(state.turns)) stopTurn(turn);
    for (const t of timers) clearTimeout(t);
  };

  const replies: Replies = {
    ...projectReplies(m),
    ...chatReplies(m),
    ...libraryReplies(m),
    ...sourceReplies(m),
    ...agentReplies(m),
    ...integrationReplies(m),
    ...settingsReplies(m),
    ...skillReplies(m),
    ...mcpReplies(m),
    ...workItemReplies(m),
    // Plugins: a folder picker (a sample folder on the library screens, cancelled elsewhere), and links and folders that open nowhere.
    "plugin:dialog|open": (args: unknown) => pickFolder(args),
    "plugin:opener|open_url": () => null,
    "plugin:opener|reveal_item_in_dir": () => null,
  };

  // The performance harness applies queued transcript events at once instead of waiting for a frame.
  (window as { __yaahFlush?: () => void }).__yaahFlush = flushTranscripts;
  mockWindows("main");
  mockIPC(
    async (cmd, args) => {
      const reply = Object.hasOwn(replies, cmd) ? replies[cmd] : undefined;
      if (!reply) {
        console.warn(`[browser-mock] no fixture for ${cmd}`);
        return null;
      }
      try {
        // A copy, as if serialised: the UI never holds the mock's own objects.
        return structuredClone(await reply((args ?? {}) as never));
      } catch (e) {
        throw rejection(e);
      }
    },
    { shouldMockEvents: true },
  );
  return state;
}

/** What `invoke` rejects with: a failed Rust command rejects with its error string, not an Error. */
const rejection = (e: unknown): unknown => (e instanceof Error ? e.message : e);
