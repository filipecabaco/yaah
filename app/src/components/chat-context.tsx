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

export function onDraft(cb: (d: Draft) => void): () => void {
  const listener = (e: Event) => cb((e as CustomEvent<Draft>).detail);
  window.addEventListener(DRAFT, listener);
  return () => window.removeEventListener(DRAFT, listener);
}

/** The open chat's message box (⌘L). */
export const focusComposer = () => document.getElementById("composer")?.focus();
