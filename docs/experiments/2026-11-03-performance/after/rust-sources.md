# Rust startup, library and live sources: before and after

3 November 2026. Branch `feat/review-1-5-7-8-9`, REVIEW.md items 9.3 (login-shell PATH, library and sources at startup),
9.7 (the component library in memory), 9.9 (live sources) and 9.11 (config reads). In
[`performance-review.md`](../../../research/performance-review.md) these are items 3, 7, 9 and 10, and the disk table.

## What changed

- **Login-shell PATH (9.3):** `run()` starts reading it on a thread and goes on (`path_env::start_login_shell`). Only something
  that needs the PATH waits for it: spawning a program, or looking one up (`path_env::path`, at most the 5 s shell timeout).
- **Startup (9.3):** the installed component libraries load on a thread (`Library::local`); anything that reads the library
  waits for that first load. `Sources::new` takes its first process scan on a thread too.
- **The library in memory (9.7):** a snapshot of every component with its `uses` worked out once. The catalog JSON and the
  component names are built once per snapshot, and the guide and skill texts are kept while the names don't change. yaah's own
  changes (save, install, update, enable, remove, a folder library reloaded) replace the snapshot at once. Edits on disk are
  noticed within 2 s: a stat of each `component.json` and of the folder libraries' files, at most every 2 s. During one
  check or render each name is resolved once.
- **API sources (9.9):** GitHub, Linear and GitLab reads go through one slot per source (keyed by its JSON with sorted keys):
  identical reads in flight make one request, and an answer is reused for 5 s. Errors go only to the reads that waited on them.
- **Tokens (9.9) and config files (9.11):** `JsonFile` keeps the parsed file while its stamp (mtime, size, inode) is unchanged,
  and updates it on its own writes: tokens, connections, settings and MCP servers cost a `stat`. `agents.json` and
  `~/.claude.json` (the servers part) are cached the same way.
- **`docker stats` (9.9):** an answer stays fresh for as long as the run took, and at least 5 s for `stats` (1 s for the rest).
- **Postgres (9.9):** a pool of up to 2 idle clients per connection URL, each closed after 60 s idle (by a reaper task, not on
  the next query). A client goes back only after its read-only transaction rolled back cleanly (and `pg_advisory_unlock_all()`).
  The role check is still redone every 60 s.

## How it was measured

- **Benchmarks:** `#[ignore]` tests timed with `Instant`, kept in [`rust-sources-bench/`](rust-sources-bench/)
  (`rust_sources_perf_before.rs` for the old APIs, `rust_sources_perf.rs` for the new ones), raw rows in
  `rust-sources-before.tsv` and `rust-sources-after.tsv`.
- **Before:** the branch's `HEAD` (`53f5e74`) in a scratch `git worktree`, plus the bench and two `pub(crate)`s.
- **After:** the working tree with these changes.
- **Build:** `cargo test --release --lib -- --ignored --test-threads=1`.
- **Real things used:** this machine's login shell (`zsh -ilc`), the local Docker daemon (3 containers), the `yaah-pg-demo`
  container as `yaah_ro`, and the integrations stand-in (a local HTTP server answering as GitHub, 30 ms per issue).
- **The library:** yaah's 23 components, 200 local ones and a 500-component folder library (723), as in the review.
- **`docker stats` runs** were counted by a logging `docker` wrapper first on `PATH`: four pollers asking every 2 s, started
  0.5 s apart, for 12 s.

## Results

| Item | Measurement | Before | After |
|---|---|---|---|
| 9.3 | `run()` blocked on the login-shell PATH before the window | 1,186 ms (1,513 ms in a second run) | **0.02 ms** |
| 9.3 | First spawn right at launch (waits for the shell instead) | — | 1,261 ms, then 0 |
| 9.3 | Library load on the setup thread (723 components) | 45 ms | **0.03 ms** (the 27 ms load runs on its own thread) |
| 9.3 | `Sources::new` on the setup thread | 6.5 ms | **0.03 ms** |
| 9.7 | `ui_catalog` JSON | 12.1 ms | **< 1 µs** (13.3 ms once after each change) |
| 9.7 | Component names for the guide | 11.0 ms | **< 1 µs** |
| 9.7 | `ui_guide` (the yaah-ui skill text) | 10.6 ms | **< 1 µs** |
| 9.7 | `guide.deliver()` for a Claude `session/new` | 21.7 ms | **0.11 ms** |
| 9.7 | `prepare` of a local component | 0.87 ms | **0.014 ms** |
| 9.7 | Validate and expand a tree with 200 local component uses | 11.8 ms | **1.9 ms** |
| 9.9 | 5 identical concurrent `github.issue` reads | 5 requests | **1 request** |
| 9.9 | …and a sixth read 1 s later | 6 requests in all | **1 in all** |
| 9.9 | `docker stats` runs for 24 reads by 4 pollers in 12 s | 4 | **2** |
| 9.9 | `postgres.query` end to end | 4.2 ms | **1.2 ms** |
| 9.9 | A token read (`connected()`, integrations.json) | 15–78 µs | **1.2 µs** |
| 9.11 | `agents.json` `Store::find` (6 profiles) | 16–73 µs | **1.7 µs** |
| 9.11 | `~/.claude.json` servers, 200 KB / 2 MB file | 0.09 / 0.96 ms | **0.001 / 0.001 ms** |

Notes:
- The login shell is still read once (0.7–1.3 s on this machine); it no longer delays the window. A chat started in the
  first second after launch waits for the rest of it, as the "first spawn" row shows.
- The "before" config reads varied between runs (15 vs 78 µs for the token, 16 vs 73 µs for `agents.json`); both runs are shown.
- A library change costs one rebuild (13 ms with 723 components), on the next read rather than on every read.
- `docker stats` answers can now be up to about 5 s old (a view polling every 2 s sees the same reading two or three times).

## Tests

Each change has a test against real things (temp folders, the stand-in HTTP server, a stand-in `docker` script, the
`yaah-pg-demo` container):

- `path_env::the_login_path_is_read_in_the_background_and_spawns_wait_for_it`
- `ui_library::the_library_in_memory_follows_saves_and_edits`, `names_are_resolved_once_per_check`, and the folder-library
  edit in `ui_libraries::skips_symlinks_and_reports_invalid_components_while_the_rest_load` (now within the 2 s window)
- `sources::api_sources_share_one_request_and_a_short_cache`, `canonical_json_ignores_key_order`,
  `docker_answers_stay_fresh_as_long_as_they_took`, `postgres_tests::clients_are_pooled_and_dropped_when_idle`
- `json_file::reads_are_cached_until_the_file_changes`, `agents::profiles_are_cached_until_the_file_changes`,
  `mcp_servers::other_tools_configs_are_read_again_only_when_they_change`
