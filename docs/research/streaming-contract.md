# Streaming and transcript contract (Rust ↔ interface)

Introduced on branch `feat/review-1-5-7-8-9` for REVIEW.md items 9.1, 9.2, 9.3, 9.5 and 9.11.

## Events

- `session-entry` `{ sessionId, index, entry }`: unchanged. A new entry, or any change that isn't a text append
  (tool calls, permissions, UI entries, plans, notices, a thought or message that started or was replaced).
- **New:** `session-append` `{ sessionId, index, field, text, len }`:
  - `field` is `"text"` for agent messages and `"thought"` for thoughts (whatever the entry's text field is called today;
    keep the existing JSON names).
  - `text` is the appended characters only.
  - `len` is the field's total length in UTF-16 code units after the append.
  - The interface applies it only when `current.length + text.length == len`. Otherwise it is out of sync: it fetches that
    entry again with `get_entries` and replaces it.
- **Coalescing:** Rust sends at most one emit per session every ~33 ms, combining appends to the same entry. It flushes
  immediately when a non-append change to that session happens (so ordering is preserved) and when the turn ends.
- **Form edits:** only the draft change is sent (`session-draft` `{ sessionId, index, draft, draftBy }`). The full UI
  entry, with any inlined images, is no longer re-sent on every keystroke.

## Commands

- `list_sessions` returns infos only (as today) and is async. Startup no longer parses every transcript.
- **New:** `get_entries({ sessionId, from?, limit? }) -> { entries, from, total }` pages a transcript (default: the
  last 200 entries). `get_transcript` stays as a thin wrapper, or is removed, if nothing else uses it.
- `list_agents` and `general_settings` become async, so they never run on the main thread.

## Persistence (Rust)

- **Per-session locks:** `HashMap<String, Arc<Mutex<Session>>>` behind a short-lived map lock. A save or emit for one
  chat never blocks another.
- **Lazy saves:** a change marks the session dirty. The saver thread snapshots (`Vec<Arc<Entry>>`, a cheap clone)
  and writes about 0.5–1 s later. A turn's end and app exit flush.
- **Lazy loading:** startup reads each session's info only; entries are parsed when the chat is first opened or
  asked for.
