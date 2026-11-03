// Transcripts in the interface: one store, read per chat with useSyncExternalStore,
// so a streamed chunk re-renders only the chat it belongs to (not the app, not the
// sidebar). Rust owns the transcript (docs/research/streaming-contract.md); this
// only applies what it sends:
// - `session-entry` puts an entry at its index;
// - `session-append` adds text to a message or thought, when its `len` says the
//   text shown is the one Rust appended to; otherwise that entry is fetched again;
// - `session-draft` swaps a form's draft.
// Events are queued and applied once per animation frame, so a burst of chunks
// costs one render. Only a few transcripts stay in memory (least recently opened
// go first); a chat's transcript is fetched with `get_entries` when it's opened.
import type { Entry, EntryPage, SessionAppendEvent, SessionDraftEvent, SessionEntryEvent } from "@/lib/api";
import { errorMessage } from "@/lib/narrow";

export type Transcript = {
  /** Entries by their index in the chat. Indexes before `from` aren't loaded. */
  entries: readonly (Entry | undefined)[];
  /** The first index loaded. */
  from: number;
  /** Entries in the chat, as far as the interface knows. */
  total: number;
  /** Why loading the chat failed, if it did. */
  error?: string;
};

export type FetchPage = (sessionId: string, from?: number, limit?: number) => Promise<EntryPage>;

type Event = ({ kind: "entry" } & SessionEntryEvent) | ({ kind: "append" } & SessionAppendEvent) | ({ kind: "draft" } & SessionDraftEvent);

/** Transcripts kept in memory (the chat on screen always stays). */
export const KEEP = 8;
/** Entries fetched by "earlier" paging. */
export const PAGE = 200;

/** Runs `f` before the next frame (or soon, when the window isn't painting). */
function nextFrame(f: () => void): () => void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    f();
  };
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : undefined;
  // A hidden window paints no frames; don't let events pile up behind it.
  const t = setTimeout(run, 100);
  return () => {
    done = true;
    if (raf !== undefined) cancelAnimationFrame(raf);
    clearTimeout(t);
  };
}

/** Apply the newest store's queued events now (tests and the performance harness). */
export const flushTranscripts = () => TranscriptStore.latest?.flush();

const key = (sessionId: string, index: number) => `${index}\u0000${sessionId}`;

export class TranscriptStore {
  static latest: TranscriptStore | null = null;
  private chats = new Map<string, Transcript>();
  private listeners = new Map<string, Set<() => void>>();
  private queue: Event[] = [];
  private cancelFlush: (() => void) | null = null;
  /** Chats being loaded, with the events that arrived meanwhile. */
  private loading = new Map<string, Event[]>();
  /** Opened chats, least recent first. */
  private recent: string[] = [];
  /** Entries being fetched again after an append didn't fit, with the appends held meanwhile. */
  private resyncing = new Map<string, { since: number; held: Event[] }>();
  /** Bumped by every `session-entry` for an index, so an older fetch of it is dropped. */
  private versions = new Map<string, number>();

  constructor(
    private fetchPage: FetchPage,
    readonly keep = KEEP,
    private schedule: (f: () => void) => () => void = nextFrame,
  ) {
    TranscriptStore.latest = this;
  }

  get(sessionId: string): Transcript | undefined {
    return this.chats.get(sessionId);
  }

  subscribe(sessionId: string, cb: () => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) this.listeners.set(sessionId, (set = new Set()));
    set.add(cb);
    return () => {
      set.delete(cb);
      if (!set.size) this.listeners.delete(sessionId);
    };
  }

  /** Chats whose transcript is in memory, least recently opened first. */
  resident(): string[] {
    return this.recent.filter((id) => this.chats.has(id));
  }

  // ── events ────────────────────────────────────────────────────────────────

  entry(e: SessionEntryEvent) {
    this.enqueue({ kind: "entry", ...e });
  }

  append(e: SessionAppendEvent) {
    this.enqueue({ kind: "append", ...e });
  }

  draft(e: SessionDraftEvent) {
    this.enqueue({ kind: "draft", ...e });
  }

  private enqueue(e: Event) {
    this.queue.push(e);
    this.cancelFlush ??= this.schedule(() => this.flush());
  }

  /** Apply every queued event; each chat that changed notifies once. */
  flush() {
    this.cancelFlush?.();
    this.cancelFlush = null;
    const queue = this.queue;
    this.queue = [];
    const changed = new Map<string, Transcript>();
    for (const e of queue) this.apply(e, changed);
    this.commit(changed);
  }

  /** A working copy of a chat's transcript for this flush (one array copy per chat, not per event). */
  private draftOf(sessionId: string, changed: Map<string, Transcript>): (Transcript & { entries: (Entry | undefined)[] }) | null {
    const hit = changed.get(sessionId);
    if (hit) return hit as Transcript & { entries: (Entry | undefined)[] };
    const t = this.chats.get(sessionId);
    if (!t || t.error) return null;
    const copy = { ...t, entries: t.entries.slice() };
    changed.set(sessionId, copy);
    return copy;
  }

  private commit(changed: Map<string, Transcript>) {
    for (const [id, t] of changed) {
      if (!this.chats.has(id)) continue;
      this.chats.set(id, t);
      this.listeners.get(id)?.forEach((cb) => cb());
    }
  }

  private apply(e: Event, changed: Map<string, Transcript>) {
    const held = this.loading.get(e.sessionId);
    if (held) return void held.push(e);
    // Chats not in memory are fetched whole when opened; their events can go.
    if (!this.chats.has(e.sessionId)) return;
    const k = key(e.sessionId, e.index);
    const resync = this.resyncing.get(k);
    if (resync && e.kind !== "entry") return void resync.held.push(e);
    const t = this.draftOf(e.sessionId, changed);
    if (!t) return;
    if (e.kind === "entry") {
      this.versions.set(k, (this.versions.get(k) ?? 0) + 1);
      t.entries[e.index] = e.entry;
      t.total = Math.max(t.total, e.index + 1);
      return;
    }
    const current = t.entries[e.index];
    if (e.kind === "draft") {
      if (current?.type === "ui") t.entries[e.index] = { ...current, draft: e.draft ?? undefined, draftBy: e.draftBy ?? undefined };
      else this.resync(e.sessionId, e.index);
      return;
    }
    const text = current && (current.type === "agent" || current.type === "thought") ? (current as Record<string, unknown>)[e.field] : undefined;
    if (typeof text === "string" && current && text.length + e.text.length === e.len) {
      t.entries[e.index] = { ...current, [e.field]: text + e.text };
      return;
    }
    // Already shown (a repeat): nothing to do.
    if (typeof text === "string" && text.length === e.len && text.endsWith(e.text)) return;
    this.resync(e.sessionId, e.index);
  }

  /** Out of sync: fetch the entry again, holding its appends until it's back. */
  private resync(sessionId: string, index: number) {
    const k = key(sessionId, index);
    if (this.resyncing.has(k)) return;
    const since = this.versions.get(k) ?? 0;
    const state = { since, held: [] as Event[] };
    this.resyncing.set(k, state);
    const done = (page: EntryPage | null) => {
      this.resyncing.delete(k);
      const changed = new Map<string, Transcript>();
      const t = this.draftOf(sessionId, changed);
      // A `session-entry` since the fetch started is newer than what came back.
      const fresh = page?.entries[0];
      if (t && fresh && page.from === index && (this.versions.get(k) ?? 0) === since) {
        t.entries[index] = fresh;
        t.total = Math.max(t.total, page.total);
      }
      for (const e of state.held) this.apply(e, changed);
      this.commit(changed);
    };
    this.fetchPage(sessionId, index, 1).then(done, (e: unknown) => {
      console.error(`could not fetch entry ${index} of ${sessionId} again`, e);
      done(null);
    });
  }

  // ── loading and memory ────────────────────────────────────────────────────

  /** The chat is on screen: load it if it isn't in memory, and keep it there. */
  open(sessionId: string) {
    this.recent = [...this.recent.filter((id) => id !== sessionId), sessionId];
    if (!this.chats.has(sessionId) && !this.loading.has(sessionId)) this.load(sessionId);
    this.evict();
  }

  /** A chat just created here: empty, no need to fetch it. */
  created(sessionId: string) {
    if (!this.chats.has(sessionId)) this.chats.set(sessionId, { entries: [], from: 0, total: 0 });
    this.recent = [...this.recent.filter((id) => id !== sessionId), sessionId];
    this.evict();
  }

  remove(sessionId: string) {
    this.chats.delete(sessionId);
    this.loading.delete(sessionId);
    this.recent = this.recent.filter((id) => id !== sessionId);
  }

  private evict() {
    while (this.resident().length > this.keep) {
      // The least recently opened that nothing is showing.
      const victim = this.resident().find((id) => !this.listeners.has(id) && id !== this.recent.at(-1));
      if (!victim) break;
      this.chats.delete(victim);
      this.recent = this.recent.filter((id) => id !== victim);
    }
  }

  private load(sessionId: string) {
    this.loading.set(sessionId, []);
    const settle = (t: Transcript) => {
      const held = this.loading.get(sessionId);
      if (!held) return; // removed meanwhile
      this.loading.delete(sessionId);
      this.chats.set(sessionId, t);
      const changed = new Map<string, Transcript>();
      for (const e of held) this.apply(e, changed);
      this.commit(changed);
      this.listeners.get(sessionId)?.forEach((cb) => cb());
      this.evict();
    };
    this.fetchPage(sessionId).then(
      (page) => {
        const entries: (Entry | undefined)[] = [];
        page.entries.forEach((entry, i) => (entries[page.from + i] = entry));
        settle({ entries, from: page.from, total: Math.max(page.total, page.from + page.entries.length) });
      },
      (e: unknown) => settle({ entries: [], from: 0, total: 0, error: `Couldn't load this chat: ${errorMessage(e)}` }),
    );
  }

  /** Fetch the `PAGE` entries before the first one loaded. Resolves once they're in. */
  async loadEarlier(sessionId: string): Promise<void> {
    const t = this.chats.get(sessionId);
    if (!t || t.from === 0) return;
    const from = Math.max(0, t.from - PAGE);
    const page = await this.fetchPage(sessionId, from, t.from - from);
    const now = this.chats.get(sessionId);
    if (!now || now.from !== t.from) return;
    const entries = now.entries.slice();
    page.entries.forEach((entry, i) => {
      // Never overwrite something newer that arrived meanwhile.
      if (entries[page.from + i] === undefined) entries[page.from + i] = entry;
    });
    this.chats.set(sessionId, { ...now, entries, from: Math.min(now.from, page.from) });
    this.listeners.get(sessionId)?.forEach((cb) => cb());
  }
}
