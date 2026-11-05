// Unsent composer text per chat. The composer remounts when the user moves to another chat, pane or
// project, so its state lives here: in memory for the session and in localStorage across reloads.
import type { Reference } from "@/lib/api";

export type Draft = { text: string; mentions: Record<string, string>; picked: Record<string, Reference> };

const PREFIX = "yaah.draft.";
/** Most drafts kept across reloads; the least recently edited go first. */
const MAX_DRAFTS = 50;
const ORDER = "yaah.draft-order";
const drafts = new Map<string, Draft>();

export function loadDraft(sessionId: string): Draft | null {
  const held = drafts.get(sessionId);
  if (held) return held;
  try {
    const raw = localStorage.getItem(PREFIX + sessionId);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (typeof d?.text !== "string" || !d.text) return null;
    const draft = { text: d.text, mentions: d.mentions ?? {}, picked: d.picked ?? {} };
    drafts.set(sessionId, draft);
    return draft;
  } catch {
    return null;
  }
}

const order = (): string[] => {
  try {
    const l = JSON.parse(localStorage.getItem(ORDER) ?? "[]") as unknown;
    return Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** Marks `sessionId` as the most recently edited, and drops the oldest drafts beyond the cap. */
function touch(sessionId: string) {
  const list = [...order().filter((id) => id !== sessionId), sessionId];
  for (const id of list.splice(0, Math.max(0, list.length - MAX_DRAFTS))) {
    drafts.delete(id);
    localStorage.removeItem(PREFIX + id);
  }
  localStorage.setItem(ORDER, JSON.stringify(list));
}

/** Forgets a chat's draft (the chat was deleted). */
export function removeDraft(sessionId: string) {
  drafts.delete(sessionId);
  try {
    localStorage.removeItem(PREFIX + sessionId);
    localStorage.setItem(ORDER, JSON.stringify(order().filter((id) => id !== sessionId)));
  } catch {
    // Nothing stored to remove.
  }
}

/** At startup: drops the drafts of chats that no longer exist. */
export function pruneDrafts(existing: Iterable<string>) {
  const keep = new Set(existing);
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const k of keys) {
      if (!k?.startsWith(PREFIX)) continue;
      const id = k.slice(PREFIX.length);
      if (!keep.has(id)) removeDraft(id);
    }
  } catch {
    // Storage unavailable: nothing to prune.
  }
}

/** Keeps the draft, or forgets it when there is no text left. */
export function saveDraft(sessionId: string, draft: Draft) {
  try {
    if (!draft.text) {
      drafts.delete(sessionId);
      localStorage.removeItem(PREFIX + sessionId);
    } else {
      drafts.set(sessionId, draft);
      localStorage.setItem(PREFIX + sessionId, JSON.stringify(draft));
      touch(sessionId);
    }
  } catch {
    // Storage full or unavailable: the in-memory draft still holds for this run.
  }
}

/** Drops every draft (tests, where session ids repeat from one test to the next). */
export function clearDrafts() {
  drafts.clear();
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const k of keys) if (k?.startsWith(PREFIX) || k === ORDER) localStorage.removeItem(k);
  } catch {
    // Nothing stored to clear.
  }
}
