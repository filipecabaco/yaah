// What a component rendered inside a chat knows about that chat. Lets deep
// components (diffs, agent-built UI) act on it: draft a question, resolve
// paths against the chat's folder, tell whether the agent is busy.
import { createContext, useContext } from "react";

/** `pane`: the split pane the chat is shown in (the same chat can be open in two). */
type ChatInfo = {
  sessionId: string;
  cwd: string;
  busy: boolean;
  pane?: string;
  /** The chat belongs to a project: what the user trusts there (an MCP server) is the project's. */
  inProject?: boolean;
};

export const ChatContext = createContext<ChatInfo | null>(null);
export const useChat = () => useContext(ChatContext);

export type Draft = { text: string; mention?: { label: string; path: string } };

/** A composer (or a test) listening for drafts: the chat and pane it belongs to, if any. */
type Listener = { cb: (d: Draft) => void; sessionId?: string; pane?: string };
const listeners = new Set<Listener>();
/** The pane the user is in (use-yaah.ts keeps it current): drafts with no pane of their own go there. */
let focusedPane: string | null = null;
export const setFocusedPane = (id: string | null) => void (focusedPane = id);
/** Whether `pane` is the one the user is in (or there are no panes to tell apart). */
export const isFocusedPane = (pane?: string) => !pane || !focusedPane || pane === focusedPane;

/**
 * Put text (and optionally an @mention) into a composer, focused, without sending:
 * the one in `pane` (the pane the action came from), else the focused pane's, else every listener.
 */
export function draftIntoComposer(draft: Draft, pane?: string) {
  const all = [...listeners];
  const target = (pane && all.find((l) => l.pane === pane)) || (focusedPane && all.find((l) => l.pane === focusedPane));
  for (const l of target ? [target] : all) l.cb(draft);
}

/** A draft waiting for its chat's composer to open (one at a time; a newer one replaces it). */
let pending: { sessionId: string; draft: Draft } | null = null;

/** Listen for drafts; `sessionId` is the chat the composer belongs to, so a draft waiting for it lands once it's open. */
export function onDraft(cb: (d: Draft) => void, sessionId?: string, pane?: string): () => void {
  const listener: Listener = { cb, sessionId, pane };
  listeners.add(listener);
  if (sessionId && pending?.sessionId === sessionId) {
    const { draft } = pending;
    pending = null;
    // After the composer's own effects have run.
    setTimeout(() => listeners.has(listener) && listener.cb(draft));
  }
  return () => void listeners.delete(listener);
}

/** Draft into chat `sessionId`'s composer (the focused pane's if it's open in several): now if it's open, otherwise as soon as it opens. Never sends. */
export function draftIntoChat(sessionId: string, draft: Draft) {
  const open = [...listeners].filter((l) => l.sessionId === sessionId);
  const target = open.find((l) => l.pane === focusedPane) ?? open[0];
  if (target) target.cb(draft);
  else pending = { sessionId, draft };
}

/** The focused pane's message box (⌘L); none when that pane shows no chat. */
export function focusComposer() {
  const scope = focusedPane ? `[data-pane-id="${focusedPane}"] ` : "";
  document.querySelector<HTMLElement>(`${scope}textarea[data-composer]`)?.focus();
}
