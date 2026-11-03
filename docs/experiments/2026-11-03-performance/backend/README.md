# Backend performance measurements (2026-11-03)

Measured performance review of yaah's Rust backend (`app/src-tauri`). The app code was not changed.

## How the numbers were taken

- **Where:** a scratch copy of the crate. The real crate's `target/` was APFS-cloned into it, and the copy was deleted afterwards.
- **Benchmarks:** temporary `#[ignore]` tests timed with `std::time::Instant` over many iterations. They are kept in [`bench-src/`](bench-src/) so the numbers can be reproduced. No crates were added.
- **Build:** `cargo test --release` (opt-level 3). LTO was off and `codegen-units` was 16 to keep rebuilds fast, so the shipped profile (fat LTO, 1 codegen unit) would likely be a little faster.
- **Allocation counts:** the lib test binary used a counting `#[global_allocator]`. That needed `unsafe_code` allowed, in the scratch copy only.
- **IPC cost:** each event went through an emitter that does what Tauri 2.12.5 does per `emit`: `serde_json::to_string` of the payload, then `format!` into the JS snippet the webview evaluates. Event sizes are the sizes of those scripts.
- **Real things used:**
  - the `acp_e2e` scripted agent as a real stdio process, with a `flood` script added (see `bench-src/acp_e2e_agent_flood.diff`);
  - the integrations stand-in HTTP server;
  - the `yaah-pg-demo` container (`yaah_ro`, db `shop`);
  - the local Docker daemon;
  - the real `claude-agent-acp@0.99.1` from the npx cache;
  - this machine's login shell.
- **Idle numbers:** the release app built with `tauri/custom-protocol`, launched with an empty temp `HOME`.
- **Machine:** Apple M5 Pro (18 cores), macOS 26 (Darwin 25.6), rustc 1.99.1, 745 processes running.
- **Estimates:** rows marked *estimate* are not measured in yaah itself. The webview proxy runs the same script in V8 (node), not in WebKit, and leaves out React and markdown rendering.

Raw rows are in [`results.tsv`](results.tsv) (area, metric, value, unit, note), and the idle samples in [`idle-samples.txt`](idle-samples.txt).

## Results

### 1. Streaming transcript updates (`session.rs`)

The agent sent chunks of 40 characters. Every chunk re-emits the whole entry it extends.

| Scenario | Rust per chunk (end of message) | IPC bytes, whole message | Total apply+emit | Allocated (cumulative) |
|---|---|---|---|---|
| 1k-char message (25 chunks) | 1.1 µs | 0.018 MB | 0.11 ms | 0.15 MB |
| 10k-char message (250 chunks) | 4.1 µs | 1.3 MB | 0.65 ms | 9.4 MB |
| 50k-char message (1,250 chunks) | 19.9 µs | 31.9 MB | 12.7 ms | 222 MB |
| 200k-char message (5,000 chunks) | 65.1 µs | 507 MB | 176 ms | 3.5 GB |
| 50k chars, 250 earlier entries | 17.0 µs | 31.9 MB | 12.1 ms | 222 MB |
| 50k chars, 2,000 earlier entries | 18.3 µs | 31.9 MB | 12.4 ms | 223 MB |
| *Alternative:* emit only the new text, 200k chars | — | 0.96 MB | 1.0 ms | — |
| `tool_call_update`, content grown to 100 KB | 35 µs per update | 10.2 MB for 200 updates | — | — |
| *Estimate:* webview eval of one chunk's script (V8 proxy), 10k / 50k / 200k message | 27 µs / ~1.0 ms / ~0.75 ms | — | — | — |

The cost grows with the size of the message (O(n²) over a message) and not with the rest of the transcript: the whole transcript is never re-emitted per chunk.

**End to end** (the scripted agent as a real process, through `acp.rs` and the Hub):

| Scenario | Wall time | yaah CPU | IPC bytes |
|---|---|---|---|
| 5,000 chunks as 100 messages of 2 KB | 8.6 ms (582k chunks/s) | 10 ms | 6.0 MB |
| 5,000 chunks into one 200 KB message | 159 ms (31k chunks/s) | 160 ms | 501 MB |
| 10,000 chunks into one 400 KB message | 620 ms (16k chunks/s) | 630 ms | 2,002 MB |

**Saving and locking** (`Shared::save` runs under the global sessions lock):

| Scenario | Value |
|---|---|
| `save()` serialisation under the lock: 200 entries (0.4 MB) | 0.13 ms |
| `save()` serialisation under the lock: 1,000 entries (1.8 MB) | 0.62 ms |
| `save()` serialisation under the lock: 1,000 heavy entries (5.6 MB) | 2.1 ms |
| `save()` serialisation under the lock: 5,000 heavy entries (27.8 MB) | 10.5 ms |
| Background write of those (saver thread, not under the lock): 0.4 / 1.8 / 5.6 / 27.8 MB | 0.23 / 0.33 / 0.55 / 2.8 ms |
| `edit_form` (each debounced user edit, or `ui_set_values`): 200 entries | 0.15 ms |
| `edit_form`: 1,000 heavy entries | 2.1 ms |
| `edit_form`: 1,000 heavy entries + a 1 MB image in the form | 2.7 ms, emits 1.0 MB per edit |
| `push_ui` (re-render by id): 200 entries | 0.14 ms |
| `push_ui`: 1,000 heavy entries | 2.1 ms |
| `push_ui`: 1,000 heavy entries + a 1 MB image | 2.9 ms |
| `get_transcript` clone + serialise: 200 entries | 0.19 ms (0.35 MB reply) |
| `get_transcript` clone + serialise: 1,000 heavy entries | 2.5 ms (5.6 MB reply) |
| Chat B chunk latency, nothing else running (p50 / p99 / max) | 8.4 / 18 / 200 µs |
| Chat B chunk latency while chat A (5,000 entries, 28 MB) takes edits and `get_transcript` (p50 / p99 / max) | 6.5 µs / **12.4 ms** / 13.4 ms |
| When saves happen | on new chat, every finished turn, every `ui_render`, `ui_ask` and `ui_set_values`, every form edit, answer, rename, move and cancelled ask; never per chunk |

### 2. ACP I/O (`acp.rs`)

| Scenario | Value |
|---|---|
| read_line + parse to `Value` + route, 40-char chunk (252 B line) | 0.63 µs per message, 1.6M msg/s (403 MB/s) |
| Allocations per small message | 21 allocations, 2.7 KB |
| Parse to `Value`, compared with the `IgnoredAny` floor | 0.52 µs vs 0.17 µs |
| 100 KB message: read + parse + route | 47 µs (2.1 GB/s), 33 allocations |

### 3. UI MCP server (`ui_mcp.rs`)

All times are round trips over loopback HTTP.

| Scenario | 23 components, 200-entry chat | 723 components (200 local + 500 in a folder library), 1,000-entry chat |
|---|---|---|
| HTTP ping (a thread per request) | 99 µs | 104 µs |
| `tools/list` | 127 µs | 131 µs |
| `ui_catalog` (not cached) | 0.40 ms, 43 KB | 15.0 ms, 435 KB |
| `ui_guide` | 0.26 ms | 11.8 ms |
| `ui_render` of a bundled component, by id | 0.64 ms | 2.5 ms |
| `ui_render` of a 2,990-node tree (223 KB) | 6.5 ms (prepare 2.9 ms) | 8.0 ms (prepare 4.0 ms) |
| `ui_get_values` | 100 µs | 179 µs |
| `ui_set_values` (saves the transcript) | 0.59 ms | 1.2 ms |

### 4. Component libraries (`ui_library.rs`, `ui_libraries.rs`)

| Operation | 23 (yaah only) | +200 local | +200 local +500 folder library | +200 local +500 git library |
|---|---|---|---|---|
| `list()` | 0.09 ms | 7.2 ms | 11.6 ms | 10.5 ms |
| `catalog()` | 0.19 ms | 7.0 ms | 12.9 ms | 11.5 ms |
| `refresh_folders()` (runs on every list/get/prepare/save) | 0 | 0 | **0.93 ms** | 0 |
| `get(local)` | — | 38 µs | **868 µs** | 47 µs |
| `prepare(local component)` | — | 70 µs | 874 µs | 75 µs |
| `prepare(library component)` | — | — | 822 µs | 21 µs |
| `prepare` of 220 local refs (~2.9k nodes) | — | 7.4 ms | 8.6 ms | 7.4 ms |
| `prepare` of 2,990 primitive nodes | 2.8 ms | 2.7 ms | 4.0 ms | 2.7 ms |
| `list_libraries()` | 0.09 ms | 6.2 ms | 7.8 ms | 6.2 ms |
| `component_names` (per session/new, guide sync, `ui_guide`) | 0.08 ms | 6.2 ms | 11.2 ms | 10.3 ms |
| `reload()` (startup) | 0.02 ms | 0.04 ms | 35 ms | 35 ms |
| `guide.deliver()` for a Claude `session/new` (723 components) | | | 22.5 ms | |

### 5. Live sources (`sources.rs`, `integrations.rs`, `work_items.rs`)

| Source | Value |
|---|---|
| `system`: one sysinfo refresh (745 processes) | 22.7 ms (p99 23.8 ms) |
| `system`: cached read within `FRESH` (1 s) | 1.4 µs |
| `system` polled every 2 s by 1 / 4 / 8 live nodes, mounted at staggered times | 1.0 / 1.8 / 2.8 % of a core |
| `docker.containers` (`docker ps -a`) | 91 ms |
| `docker.stats` (all containers, `--no-stream`) | **2,075 ms** |
| `docker.logs --tail 200` | 25 ms |
| `docker.stats`, 4 concurrent identical reads | 2,075 ms (one CLI run is shared) |
| Postgres `open()`: a new connection per query | 3.9 ms |
| Postgres `check_role()` (cached 60 s) | 0.50 ms |
| `postgres.query` end to end (connect each time) | 4.2 ms |
| *Alternative:* the same statements on a reused connection | 0.92 ms |
| `postgres.schema` end to end | 8.1 ms |
| GitHub GraphQL round trip (local stand-in, the shared client) | 107 µs |
| GitHub GET of a 20 KB diff | 111 µs |
| GitLab GET | 85 µs |
| Linear GraphQL | 91 µs |
| *Alternative:* a new `reqwest::Client` per request (loopback, no TLS) | 198 µs |
| 5 identical concurrent GitHub reads | **5 requests** (no dedup or cache) |

### 6. Startup (`lib.rs` `run()`)

| Step | Value |
|---|---|
| `adopt_login_shell` (`zsh -ilc`, this machine's rc files), before `tauri::Builder` | **703 ms mean, 1,280 ms max** (5 runs) |
| `load_sessions`: 20 chats × 200 entries (7 MB) | 4.8 ms |
| `load_sessions`: 100 × 200 (35 MB) | 26 ms |
| `load_sessions`: 100 × 1,000 (176 MB) | 130 ms |
| `Library::local()` reload with a 500-component library | 35 ms |
| `Sources::new()` (first process scan) | 6.1 ms |
| `Guide::sync`, first run (writes files) / unchanged (background thread) | 1.6 ms / 0.21 ms |

### 7. Agent processes and idle

| Scenario | Value |
|---|---|
| New chat with the agent stopped: spawn + `initialize` + `session/new` (scripted Rust agent) | 8.6 ms |
| New chat with the agent running: `session/new` only | 0.15 ms |
| `claude-agent-acp` via `npx -y` (what yaah runs), time to the `initialize` answer | 405–431 ms |
| `claude-agent-acp` via `node <cached dist/index.js>` | 127–140 ms |
| RSS of the agent process tree: via npx / via node directly | 245 MB / 130 MB |
| yaah idle (release build, empty HOME): CPU | 0.0 % over 30 s, 0.20 s CPU total including startup |
| yaah idle: RSS of the yaah process | 108 MB, 31 threads, 69 fds (WebKit helper processes not counted) |

### 8. Disk I/O on hot paths (`json_file.rs` and others)

| Read | Cost | When |
|---|---|---|
| `agents.json` (`Store::find`) | 19 µs | every prompt, new chat and login check |
| `settings.json` | 16 µs | every `session/new` (`teach_agents`) |
| `connections.json` | 15 µs | every Postgres read (every live poll) |
| `integrations.json` | 14 µs | every GitHub, Linear or GitLab request (GitLab twice) |
| `~/.claude.json` read + parse, 200 KB / 2 MB | 0.16 / 1.3 ms | every Claude `session/new` and `session/load` (`mcp_servers::inject`) |
| `JsonFile::update` (write + fsync + rename) | 4.0 ms | e.g. `record_report` on every agent start |
| Local component files | ~36 µs each | every `list`, `catalog`, `get`, `prepare` and `resolve` (no cache) |
