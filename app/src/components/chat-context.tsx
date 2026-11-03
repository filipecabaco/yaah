// What a component rendered inside a chat knows about that chat. Lets deep
// components (diffs, agent-built UI) act on it: draft a question, resolve
// paths against the chat's folder, tell whether the agent is busy.
import { createContext, useContext } from "react";

type ChatInfo = { sessionId: string; cwd: string; busy: boolean };

export const ChatContext = createContext<ChatInfo | null>(null);
export const useChat = () => useContext(ChatContext);

const DRAFT = "yaah:draft";
export type Draft = { text: string; mention?: { label: string; path: string } };

/** Put text (and optionally an @mention) into the open chat's composer, focused, without sending. */
export function draftIntoComposer(draft: Draft) {
  window.dispatchEvent(new CustomEvent<Draft>(DRAFT, { detail: draft }));
}

/** A draft waiting for its chat's composer to open (one at a time; a newer one replaces it). */
let pending: { sessionId: string; draft: Draft } | null = null;
/** Chats whose composer is listening right now. */
const listening = new Map<string, number>();

/** Listen for drafts; `sessionId` is the chat the composer belongs to, so a draft waiting for it lands once it's open. */
export function onDraft(cb: (d: Draft) => void, sessionId?: string): () => void {
  const listener = (e: Event) => cb((e as CustomEvent<Draft>).detail);
  window.addEventListener(DRAFT, listener);
  if (sessionId) {
    listening.set(sessionId, (listening.get(sessionId) ?? 0) + 1);
    if (pending?.sessionId === sessionId) {
      const { draft } = pending;
      pending = null;
      // After the composer's own effects have run.
      setTimeout(() => draftIntoComposer(draft));
    }
  }
  return () => {
    window.removeEventListener(DRAFT, listener);
    if (sessionId) listening.set(sessionId, (listening.get(sessionId) ?? 1) - 1);
  };
}

/** Draft into chat `sessionId`'s composer: now if it's open, otherwise as soon as it opens. Never sends. */
export function draftIntoChat(sessionId: string, draft: Draft) {
  if (listening.get(sessionId)) draftIntoComposer(draft);
  else pending = { sessionId, draft };
}

/** The open chat's message box (⌘L). */
export const focusComposer = () => document.getElementById("composer")?.focus();
