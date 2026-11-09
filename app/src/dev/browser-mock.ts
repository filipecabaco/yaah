// Dev-only: lets the UI run in a plain browser (`pnpm dev`, then open
// http://localhost:1420) by answering Rust commands with fixtures, and is the
// backend for the integration tests. Never loaded inside Tauri or in a
// production build. Each area lives in src/dev/mock/.
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { agentReplies } from "./mock/agents";
import { attachmentReplies, installDragBridge, pickAttachments } from "./mock/attachments";
import { chatReplies, stopTurn } from "./mock/chats";
import { configReplies } from "./mock/config";
import { diffReplies } from "./mock/diff";
import type { Mock, Replies } from "./mock/context";
import { integrationReplies } from "./mock/integrations";
import { libraryReplies, pickFolder } from "./mock/library";
import { mcpReplies } from "./mock/mcp";
import { projectReplies } from "./mock/projects";
import { providerReplies } from "./mock/providers";
import { resumeReplies } from "./mock/resume";
import { settingsReplies } from "./mock/settings";
import { skillReplies } from "./mock/skills";
import { sourceReplies } from "./mock/sources";
import { createState } from "./mock/state";
import { workItemReplies } from "./mock/work-items";
import { referenceReplies } from "./mock/references";
import { terminalReplies } from "./mock/terminals";
import { flushTranscripts } from "@/lib/transcripts";
import type { UiOpenPaneEvent } from "@/lib/api";

export type BrowserMockOptions = {
  /** Multiplies every artificial wait (default 1). 0: no waiting, only a macrotask between events. */
  delay?: number;
  /** Start with no agents, for the first-run setup screen (default: `?first-run` in the URL). */
  firstRun?: boolean;
};

/** Stops the previous install's replays and timers, so a reinstall starts clean. */
let disposePrevious: (() => void) | undefined;

/** Stops the current install's replays and timers: tests call it before unmounting, so nothing
 * the mock was still streaming reaches a listener that is gone. */
export function disposeBrowserMock() {
  disposePrevious?.();
}
// For the test setup, which stops it after every test without loading the mock into tests that never use it.
(globalThis as { __yaahDisposeMock?: () => void }).__yaahDisposeMock = disposeBrowserMock;

/**
 * Answers every command the UI invokes, from fresh state each time it is called.
 * Returns that state, so a test can set up what Rust would have (e.g. a transcript on disk).
 */
export function installBrowserMock(options: BrowserMockOptions = {}) {
  disposePrevious?.();
  // `?mock-delay=4` in the URL slows every replay down (time to queue messages while a turn runs).
  const delay = options.delay ?? (Number(new URLSearchParams(location.search).get("mock-delay")) || 1);
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
  // Files dragged in from the OS arrive as Tauri's drag-drop events, as in the app.
  const removeDragBridge = installDragBridge(m);
  disposePrevious = () => {
    removeDragBridge();
    for (const turn of Object.values(state.turns)) stopTurn(turn);
    for (const t of timers) clearTimeout(t);
    for (const t of Object.values(state.terminals)) clearInterval(t.timer);
    disposePrevious = undefined;
  };

  const replies: Replies = {
    ...projectReplies(m),
    ...chatReplies(m),
    ...configReplies(m),
    ...libraryReplies(m),
    ...sourceReplies(m),
    ...agentReplies(m),
    ...integrationReplies(m),
    ...settingsReplies(m),
    ...skillReplies(m),
    ...mcpReplies(m),
    ...providerReplies(m),
    ...workItemReplies(m),
    ...referenceReplies(m),
    ...terminalReplies(m),
    ...diffReplies(),
    ...resumeReplies(m),
    ...attachmentReplies(m),
    // Plugins: a folder picker (a sample folder on the library screens, cancelled elsewhere), and links and folders that open nowhere.
    "plugin:dialog|open": (args: unknown) => pickAttachments(args) ?? pickFolder(args),
    "plugin:opener|open_url": () => null,
    "plugin:opener|reveal_item_in_dir": () => null,
  };

  // The performance harness applies queued transcript events at once instead of waiting for a frame.
  (window as { __yaahFlush?: () => void }).__yaahFlush = flushTranscripts;
  // What the agent's `ui_open_pane` sends (ui_mcp.rs), by hand: e.g. from the console or a browser tool,
  // `__yaahOpenPane({ sessionId: "replay-1", direction: "right", content: { kind: "ui", chat: "replay-1", index: 1 } })`.
  // Prompts with "side pane" or "diff in a pane" make the mock agent do it itself (mock/chats.ts).
  (window as { __yaahOpenPane?: (e: UiOpenPaneEvent) => Promise<void> }).__yaahOpenPane = (e) => m.emit("ui-open-pane", e);
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
