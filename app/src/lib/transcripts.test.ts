// The transcript store against the browser mock: the mock's `get_entries` and the
// events it emits are the ones session.rs sends (docs/research/streaming-contract.md).
import { emit } from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowserMock } from "@/dev/browser-mock";
import { api, events, type Entry } from "@/lib/api";
import { TranscriptStore, type FetchPage } from "@/lib/transcripts";

/** A store wired to the mock's events, flushed by hand (no frames in a test). */
function storeWith(keep = 8) {
  const fetches: { id: string; from?: number; limit?: number }[] = [];
  const fetchPage: FetchPage = (id, from, limit) => {
    fetches.push({ id, from, limit });
    return api.getEntries(id, from, limit);
  };
  let scheduled = 0;
  const store = new TranscriptStore(fetchPage, keep, () => {
    scheduled++;
    return () => undefined;
  });
  const off = [events.sessionEntry((e) => store.entry(e)), events.sessionAppend((e) => store.append(e)), events.sessionDraft((e) => store.draft(e))];
  const dispose = () => off.forEach((p) => void p.then((f) => f()));
  return { store, fetches, scheduled: () => scheduled, dispose };
}

/** Wait for the store to have loaded `id`. */
const loaded = (store: TranscriptStore, id: string) => vi.waitFor(() => expect(store.get(id)).toBeDefined());

const text = (store: TranscriptStore, id: string, index: number) => {
  const e = store.get(id)?.entries[index];
  return e && "text" in e ? e.text : undefined;
};

let cleanup: (() => void) | undefined;
let mock: ReturnType<typeof installBrowserMock>;
beforeEach(() => {
  mock = installBrowserMock({ delay: 0 });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** A quick chat whose transcript is `entries` on Rust's side (as if restored from disk). */
async function chatWith(entries: Entry[]) {
  const chat = await api.newQuickChat("default");
  mock.transcripts[chat.sessionId] = structuredClone(entries);
  return chat.sessionId;
}

describe("session-append", () => {
  it("applies text when its len says the shown text is the one Rust appended to", async () => {
    const s = storeWith();
    cleanup = s.dispose;
    const id = (await api.newQuickChat("default")).sessionId;
    s.store.created(id);
    await emit("session-entry", { sessionId: id, index: 0, entry: { type: "agent", text: "Hel", messageId: null } });
    await emit("session-append", { sessionId: id, index: 0, field: "text", text: "lo", len: 5 });
    await emit("session-append", { sessionId: id, index: 0, field: "text", text: " world", len: 11 });
    s.store.flush();
    expect(text(s.store, id, 0)).toBe("Hello world");
    expect(s.fetches).toEqual([]);
  });

  it("counts len in UTF-16 code units, as JS strings do (emoji are two)", async () => {
    const s = storeWith();
    cleanup = s.dispose;
    const id = (await api.newQuickChat("default")).sessionId;
    s.store.created(id);
    await emit("session-entry", { sessionId: id, index: 0, entry: { type: "thought", text: "é", messageId: null } });
    // "é" is 1 unit, "🙂" is 2, "naïve" is 5: 1 + 2 + 5 = 8.
    await emit("session-append", { sessionId: id, index: 0, field: "text", text: "🙂", len: 3 });
    await emit("session-append", { sessionId: id, index: 0, field: "text", text: "naïve", len: 8 });
    s.store.flush();
    expect(text(s.store, id, 0)).toBe("é🙂naïve");
    expect(s.fetches).toEqual([]);
  });

  it("out of sync (a chunk went missing): fetches the entry again and replaces it", async () => {
    const s = storeWith();
    cleanup = s.dispose;
    // In the mock (Rust's side) the message is whole; the interface missed a chunk.
    const id = await chatWith([{ type: "agent", text: "The full reply, as Rust has it.", messageId: null }]);
    s.store.open(id);
    await loaded(s.store, id);
    s.fetches.length = 0;
    await emit("session-entry", { sessionId: id, index: 0, entry: { type: "agent", text: "The full", messageId: null } });
    // Rust's text is 31 long after this append; the interface has 8 + 1 ≠ 31.
    await emit("session-append", { sessionId: id, index: 0, field: "text", text: ".", len: 31 });
    s.store.flush();
    await vi.waitFor(() => expect(text(s.store, id, 0)).toBe("The full reply, as Rust has it."));
    expect(s.fetches).toEqual([{ id, from: 0, limit: 1 }]);
  });

  it("holds appends that arrive while the entry is fetched again, then applies the ones that fit", async () => {
    const s = storeWith();
    cleanup = s.dispose;
    const id = await chatWith([{ type: "agent", text: "abc", messageId: null }]);
    s.store.open(id);
    await loaded(s.store, id);
    // A gap: Rust has "abcdef…" but the interface never saw "def".
    await emit("session-append", { sessionId: id, index: 0, field: "text", text: "g", len: 7 });
    s.store.flush();
    // Meanwhile Rust's entry is "abcdefg" and then "abcdefgh" arrives as an append.
    mock.transcripts[id][0] = { type: "agent", text: "abcdefgh", messageId: null };
    await emit("session-entry", { sessionId: id, index: 0, entry: { type: "agent", text: "abcdefg", messageId: null } });
    s.store.flush();
    await emit("session-append", { sessionId: id, index: 0, field: "text", text: "h", len: 8 });
    s.store.flush();
    await vi.waitFor(() => expect(text(s.store, id, 0)).toBe("abcdefgh"));
  });

  it("ignores a repeated append that's already shown", async () => {
    const s = storeWith();
    cleanup = s.dispose;
    const id = (await api.newQuickChat("default")).sessionId;
    s.store.created(id);
    await emit("session-entry", { sessionId: id, index: 0, entry: { type: "agent", text: "ab", messageId: null } });
    await emit("session-append", { sessionId: id, index: 0, field: "text", text: "c", len: 3 });
    await emit("session-append", { sessionId: id, index: 0, field: "text", text: "c", len: 3 });
    s.store.flush();
    expect(text(s.store, id, 0)).toBe("abc");
    expect(s.fetches).toEqual([]);
  });

  it("applies a burst of events in one go: one notification per chat, one array copy", async () => {
    const s = storeWith();
    cleanup = s.dispose;
    const id = (await api.newQuickChat("default")).sessionId;
    s.store.created(id);
    const seen: unknown[] = [];
    s.store.subscribe(id, () => seen.push(s.store.get(id)));
    await emit("session-entry", { sessionId: id, index: 0, entry: { type: "agent", text: "", messageId: null } });
    let len = 0;
    for (let i = 0; i < 100; i++) {
      len += 3;
      await emit("session-append", { sessionId: id, index: 0, field: "text", text: "abc", len });
    }
    // Nothing is applied until the frame; then once.
    expect(s.store.get(id)?.entries).toEqual([]);
    expect(s.scheduled()).toBe(1);
    s.store.flush();
    expect(seen).toHaveLength(1);
    expect(text(s.store, id, 0)).toHaveLength(300);
  });

  it("streams a recorded reply end to end through the mock (session-append per chunk)", async () => {
    const s = storeWith();
    cleanup = s.dispose;
    const appends: number[] = [];
    const off = await events.sessionAppend((e) => appends.push(e.len));
    const id = (await api.newQuickChat("default")).sessionId;
    s.store.created(id);
    await api.sendPrompt(id, "show me markdown with links");
    await vi.waitFor(() => {
      s.store.flush();
      expect(text(s.store, id, 1)).toMatch(/It backs off up to five times\.$/);
    });
    off();
    expect(appends.length).toBeGreaterThan(3);
    expect(s.fetches).toEqual([]);
    // What the interface built from appends is exactly what Rust (the mock) has.
    expect((await api.getEntries(id)).entries[1]).toEqual(s.store.get(id)?.entries[1]);
  });
});

describe("session-draft", () => {
  it("swaps only the form's draft, keeping the rest of the UI entry as it is", async () => {
    const s = storeWith();
    cleanup = s.dispose;
    const ui: Entry = { type: "ui", askId: "a1", answer: null, title: "Trip", component: null, version: null, tree: { type: "form" }, props: {} };
    const id = await chatWith([ui]);
    s.store.open(id);
    await loaded(s.store, id);
    const before = s.store.get(id)?.entries[0];
    const drafts: unknown[] = [];
    const off = await events.sessionDraft((e) => drafts.push(e));
    await api.editUi(id, 0, { city: "Lisbon" });
    s.store.flush();
    off();
    expect(drafts).toEqual([{ sessionId: id, index: 0, draft: { city: "Lisbon" }, draftBy: { city: "user" } }]);
    const after = s.store.get(id)?.entries[0];
    expect(after).toMatchObject({ ...ui, draft: { city: "Lisbon" }, draftBy: { city: "user" } });
    expect(after && "tree" in after && before && "tree" in before && after.tree === before.tree).toBe(true);
  });
});

describe("loading and memory", () => {
  it("loads the last page with get_entries and pages earlier ones in", async () => {
    const s = storeWith();
    cleanup = s.dispose;
    const id = await chatWith(Array.from({ length: 250 }, (_, i): Entry => ({ type: "user", text: `m${i}`, attachments: [] })));
    s.store.open(id);
    await loaded(s.store, id);
    expect(s.store.get(id)).toMatchObject({ from: 50, total: 250 });
    expect(s.store.get(id)?.entries[49]).toBeUndefined();
    await s.store.loadEarlier(id);
    expect(s.store.get(id)?.from).toBe(0);
    expect(s.store.get(id)?.entries.map((e) => e && "text" in e && e.text)).toEqual(Array.from({ length: 250 }, (_, i) => `m${i}`));
  });

  it("keeps events that arrive while a chat loads, and applies them after", async () => {
    const s = storeWith();
    cleanup = s.dispose;
    const id = await chatWith([{ type: "agent", text: "hi", messageId: null }]);
    s.store.open(id);
    // Sent while get_entries is on its way (and not in what it returns).
    await emit("session-entry", { sessionId: id, index: 1, entry: { type: "user", text: "again", attachments: [] } });
    s.store.flush();
    await loaded(s.store, id);
    expect(s.store.get(id)?.entries.map((e) => e?.type)).toEqual(["agent", "user"]);
  });

  it("evicts the least recently opened transcript, never the one on screen, and reloads it on open", async () => {
    const s = storeWith(2);
    cleanup = s.dispose;
    const ids = [
      await chatWith([{ type: "user", text: "a", attachments: [] }]),
      await chatWith([{ type: "user", text: "b", attachments: [] }]),
      await chatWith([{ type: "user", text: "c", attachments: [] }]),
    ];
    for (const id of ids) {
      s.store.open(id);
      await loaded(s.store, id);
    }
    // Three opened, two kept: the first went.
    expect(s.store.resident()).toEqual([ids[1], ids[2]]);
    expect(s.store.get(ids[0])).toBeUndefined();
    // Events for a chat not in memory are dropped (it's fetched whole when opened).
    mock.transcripts[ids[0]].push({ type: "user", text: "while away", attachments: [] });
    await emit("session-entry", { sessionId: ids[0], index: 1, entry: { type: "user", text: "while away", attachments: [] } });
    s.store.flush();
    expect(s.store.get(ids[0])).toBeUndefined();

    // A chat someone is showing stays, even when it's the oldest.
    const off = s.store.subscribe(ids[1], () => undefined);
    s.store.open(ids[0]);
    await loaded(s.store, ids[0]);
    expect(s.store.resident().sort()).toEqual([ids[0], ids[1]].sort());
    expect(s.store.get(ids[2])).toBeUndefined();
    off();
    // Reloaded from get_entries, with what happened while it was out of memory.
    expect(s.store.get(ids[0])?.entries.map((e) => e && "text" in e && e.text)).toEqual(["a", "while away"]);
    expect(s.fetches.filter((f) => f.id === ids[0])).toHaveLength(2);
  });

  it("shows why a chat couldn't load", async () => {
    const store = new TranscriptStore(() => Promise.reject(new Error("disk on fire")));
    store.open("x");
    await vi.waitFor(() => expect(store.get("x")?.error).toBe("Couldn't load this chat: disk on fire"));
  });
});
