# Rust sessions and streaming: before and after

3 November 2026. Branch `feat/review-1-5-7-8-9`, REVIEW.md items 9.1, 9.2 and 9.3 (Rust side), following
[`streaming-contract.md`](../../../research/streaming-contract.md). The table in
[`performance-review.md`](../../../research/performance-review.md) covers these as items 1, 2, 3 (lazy transcripts), 13 and 14.

## What changed

- **Appends (9.1):** a message or thought that grows is sent as `session-append { sessionId, index, field, text, len }`, not the
  whole entry again. `len` is the field's length in UTF-16 code units. A message that starts, and any other change, is still a
  `session-entry`.
- **Coalescing (9.1):** at most one append per chat every 33 ms. Appends to one entry are joined. What's waiting goes out before
  any other event of that chat, and before the turn's end.
- **Per-chat locks (9.2):** `HashMap<String, Arc<Mutex<Session>>>`. The map is locked only to find, add or remove a chat.
- **Lazy saves (9.2):** a change marks the chat dirty. The saver thread snapshots it (`Vec<Arc<Entry>>`, a copy of pointers),
  then serialises and writes it outside the lock, 750 ms after the first unsaved change. A turn's end writes at once. Exit
  (`Hub::flush`, and dropping the Hub) writes everything still dirty.
- **Form drafts (9.2):** an edit sends `session-draft { sessionId, index, draft, draftBy }`, not the UI entry with its inlined images.
- **Lazy transcripts (9.3):** startup reads each chat's info only, and stops reading a file once it has the info. Entries are
  parsed when a chat is first used. `get_entries({ sessionId, from?, limit? })` pages them (by default the last 200).
- **Off the main thread (13):** `list_sessions`, `list_agents` and `general_settings` are async now.

## How it was measured

- **Benchmarks:** temporary `#[ignore]` tests, kept in [`rust-sessions-bench/`](rust-sessions-bench/). The raw rows are in
  `rust-sessions-results.tsv`.
- **Before:** the crate at `113ed35` (`git archive`, in a scratch folder).
- **After:** the same crate with only this change's files (`session.rs`, `commands.rs`, `general_settings`, the `get_entries`
  registration). That keeps the other agents' unfinished changes out of the numbers.
- **Build:** `cargo test --release`, with LTO off and 16 codegen units (as in the original review).
- **Machine:** Apple M5 Pro, macOS 26, rustc 1.99.1.
- **IPC bytes:** each emit goes through an emitter that does what Tauri 2.12.5 does: `serde_json::to_string` of the payload,
  then `format!` into the JS snippet the webview evaluates. The bytes are the size of those snippets.
- **Streams:** 40-character chunks, as in the original review.
- **"Rust time":** `apply_update` plus the emit, summed over the chunks and the turn's end (and, after, the dirty mark).
  Pauses between chunks aren't counted.

## Results

### Streaming one long reply (9.1)

| Message | Before: IPC | Before: Rust time | After, one append per chunk (no coalescing): IPC | Rust time | After, coalesced, chunks back to back: IPC / events | Rust time | After, coalesced, a chunk every ~1 ms: IPC / events | Rust time |
|---|---|---|---|---|---|---|---|---|
| 50k characters (1,250 chunks) | 31.9 MB | 15.4 ms | 0.27 MB | 0.62 ms | 0.05 MB / 4 | 0.14 ms | 0.06 MB / 52 | 1.1 ms |
| 200k characters (5,000 chunks) | **506.8 MB** | **205 ms** | 1.10 MB | 2.6 ms | 0.20 MB / 4 | 0.52 ms | **0.24 MB / 195** | 4.6 ms |

- **IPC for a 200k reply:** 507 MB → about 1 MB with an append per chunk, and 0.24 MB once coalesced, at a realistic pace.
  The paced run has about 30 events a second (195 in about 6.3 s).
- **Rust time:** 205 ms → 2.6 ms (one append per chunk) or 4.6 ms (paced). The paced run is slower than back to back because
  195 appends really go out and the caches are cold between chunks. Per chunk, the cost no longer grows with the message.
- **Rust time, back to back:** 0.5 ms. Almost every chunk joins the waiting append.

### Another chat's chunk latency while a 28 MB chat takes edits (9.2)

Chat A has 5,000 heavy entries (28 MB). It takes a form edit and a whole-transcript read every 20 ms. Chat B streams a chunk
every 0.5 ms for 3 s.

| Chat B chunk latency | Before p50 / p99 / max | After p50 / p99 / max |
|---|---|---|
| Nothing else running | 10.5 / 40.5 / 89 µs | 0.21 / 2.7 / 11 µs |
| While chat A takes edits and `get_transcript` | 9.2 µs / **14.5 ms** / 17.7 ms | 0.21 / **2.5** / 9.6 µs |
| The same, with every edit written at once (save delay 0) | n/a | 0.25 / 2.8 / 16 µs |

- **Cross-chat stall:** p99 under load went from 14.5 ms to 2.5 µs, the same as with nothing else running. Chat A's
  serialisation and its transcript copy no longer hold any lock chat B needs. Even writing A on every edit leaves B
  unchanged.
- **The uncontended row also dropped (10.5 → 0.21 µs p50).** Before, every chunk re-serialised B's growing entry for the
  emit. Now most chunks join a waiting append.

### Form edits (9.2)

| `edit_form`, 1,000 heavy entries and a 1 MB image in the form | Before | After |
|---|---|---|
| IPC per edit | 1,001,645 B (the whole UI entry) | **193 B** (`session-draft`) |
| Rust time per edit | 2,959 µs (the whole transcript serialised under the lock) | **8.2 µs** (the save is only marked) |

### Startup (9.3)

| 100 saved chats | Before: `load_sessions` | After: `load_sessions` | After: first `get_entries` of one chat |
|---|---|---|---|
| 200 entries each (35 MB) | 26.2 ms | **2.0 ms** | 0.36 ms |
| 1,000 entries each (176 MB) | 132.8 ms | **3.7 ms** | 1.2 ms |

- **Startup:** it no longer grows with the size of the transcripts. It now reads only the start of each file, up to the end
  of `info`.
- **Opening a chat:** the first time, it pays for that chat only (about 1 ms for 1,000 entries).

## Not measured

- The webview side of appends (the interface agent measures that).
- `tool_call_update`: it still sends the whole tool entry. ACP updates replace `content` wholesale, so a field diff would
  rarely be smaller, and the contract has no event for it.
- The shipped release profile (fat LTO, 1 codegen unit). It would likely be a little faster on both sides.
