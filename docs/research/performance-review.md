# Performance review

3 November 2026. A measured review of the Rust side and the interface. No app code was changed. Evidence (raw numbers,
benchmark code, screenshots):
- [Rust side](../experiments/2026-11-03-performance/backend/): `results.tsv`, `bench-src/`
- [Interface](../experiments/2026-11-03-performance/frontend/): `results.json`, harness, screenshots

**How it was measured:**
- **Rust:** `--release` benchmarks in a scratch copy of the crate, on an M5 Pro.
- **Interface:** Chrome driven by vitro against a production React build with the browser mock (an Apple-silicon Mac, 1440×900). WebKit and WebKitGTK were not measured; expect them to be about 1.5–3× slower (an estimate).
- **Estimates** are marked *(est.)*.

## Summary

yaah is fast at rest:
- **Idle:** 0 % CPU and 108 MB.
- **First paint:** about 20 ms, largest paint 68–128 ms.
- **Scrolling** a 10k-node transcript is smooth, and tables, charts and trees render in about one frame.
- **No leaks** in listeners, timers or maps.

The costs are in a few paths that grow with use:
- long streamed replies;
- big chats and saves;
- launch (login shell);
- repeated work on the component library, agent starts and live sources.

## Measured numbers (selected)

| Area | Measurement | Result |
|---|---|---|
| Streaming | Data passed from Rust to the interface for one message of 1k / 10k / 50k / 200k characters | 0.018 / 1.3 / 32 / **507 MB** |
| Streaming | Interface cost per chunk at 1k / 10k / 50k characters (Markdown) | 2.3 / 5.6 / **20.7 ms** (plain text: 1.0 / 1.5 / 3.6) |
| Streaming | One 50k reply in total | about 24 s of main-thread work *(est.)*, about 52 MB of IPC |
| Streaming | Rust apply + emit per chunk at 200k | 65 µs; 176 ms in total vs **1 ms** if only the new text were sent |
| Saves | Serialising the transcript under the global lock: 5.6 / 28 MB chat | 2.1 / 10.5 ms |
| Saves | Another chat's chunk latency, p99, while a 28 MB chat takes edits | 18 µs → **12.4 ms** |
| Chat switch | 240 / 1000 entries; a chat with heavy agent UI | 191 / 406–462 ms; **868 ms** (about 620 ms of it in Mermaid) |
| First visit | Settings tab or lazy agent-UI kind | about **300 ms** (React's Suspense hold-back, not loading) |
| Launch | Login-shell PATH before the window (`zsh -ilc`) | **703 ms** mean, 1.28 s max |
| Launch | `load_sessions` with 100 chats (35 / 176 MB) | 26 / 130 ms |
| Agents | `claude-agent-acp` time to initialize: `npx -y` vs `node <bin>` | 405–431 ms vs 127–140 ms; 245 vs 130 MB RSS |
| Library | `ui_catalog` with 23 / 723 components | 0.40 ms / 15 ms, 435 KB, uncached |
| Library | Guide delivered per Claude `session/new` (723 components) | 22.5 ms |
| Sources | `docker.stats` per call | **2,075 ms**, shared for only 1 s |
| Sources | Postgres query: new connection vs reused | 4.2 vs 0.92 ms |
| Sources | 5 identical GitHub reads at once | 5 HTTP requests |
| Sources | 10 live charts polling every 2 s, all scrolled off screen | 50 reads in 10 s |
| Interaction | Command palette with 330 items | 8–37 ms of JS per keystroke |
| Diffs | Review of a 5000-line file | 527 ms, 50k DOM nodes; above the LCS cap the diff is **wrong** (+4999 −4999) |
| Bundle | Main chunk / JS loaded at startup | 733 kB (219 kB gzip) / 838 kB; the heavy libraries are already lazy |

## Bottlenecks and fixes, ranked by user impact

| # | Problem | Where | Fix | Effort | Expected gain |
|---|---|---|---|---|---|
| 1 | **Long replies cost O(n²).** Every chunk re-sends the whole entry, and the interface re-parses all the Markdown | `session.rs:382-384, 1185-1187, 1217, 1249`; `entries.tsx:114-126`; `markdown.tsx:59-67`; `use-yaah.ts:48-54` | Emit only the appended text (`{index, append}`); coalesce emits to about 30/s per session; batch updates per animation frame; split streaming Markdown into blocks memoised per block | M (both sides) | IPC 507 MB → about 1 MB per 200k message; per-chunk interface cost back to about 2–3 ms *(est.)* |
| 2 | **Saves block every chat.** Each edit or render re-serialises the whole chat under one global lock | `session.rs:367, 376, 398-409` | Per-session locks; lazy dirty-flag saves on the saver thread (`Vec<Arc<Entry>>` snapshots); emit only the draft change for form edits | M | Removes 2–12 ms stalls across chats; one write per burst |
| 3 | **Launch waits for the login shell** | `path_env.rs:24-28`, `lib.rs:36` | Read PATH in the background (or use a cached one), and wait for it only when spawning; load transcripts lazily; load libraries and sources in the background | S (+M) | 0.7–1.3 s faster launch |
| 4 | **Opening a chat redraws everything** | `diagram.tsx:35-44`, `chat.tsx:106-121` | Cache Mermaid SVG by (theme, text); `content-visibility: auto` on entries or windowing; optionally cache parsed Markdown | S–M | Heavy chat 870 → about 250 ms *(est.)* |
| 5 | **Every chunk re-renders the whole app,** even for background chats | `use-yaah.ts:25`, `App.tsx`, `sidebar.tsx:88`, `command-palette.tsx:375` | A per-session store read with `useSyncExternalStore`; memoise the Sidebar; build palette items only when open | M | About 2–3 ms per chunk at 300 chats |
| 6 | **First visits wait 300 ms** | `agent-setup.tsx:10-17`, `ui-render.tsx:31-48`, `cli/views.tsx:728` | Preload `import()` factories (on open or when idle); `startTransition` for tab switches | S | About −300 ms per first visit |
| 7 | **The component library is re-read on every call** | `ui_library.rs:182-206, 303-319, 390-405, 502-532`; `ui_libraries.rs:824, 953`; `agent_guide.rs:311-341` | Keep components in memory with `uses` computed once; invalidate on change (mtime or fingerprint at most every ~2 s); cache the catalog JSON and the guide | M | Catalog and guide 12–22 ms → <1 ms; `session/new` −22 ms |
| 8 | **Every agent start goes through `npx -y`** | `agents.rs:555-557` | Run `node <cached bin>` after the first run (or install into `~/.yaah/agents/`); npx as the fallback | S–M | −280 ms and −115 MB per agent |
| 9 | **Live sources over-poll:** offscreen nodes keep polling, identical sources aren't shared, there's no short cache for APIs, and `docker.stats` runs almost constantly | `ui-render.tsx:751-802`; `integrations.rs:597-677`; `sources.rs:25, 283-293`; `work_items.rs:1067` | Pause offscreen nodes (IntersectionObserver); one poller per source key; in-flight dedup + 5–10 s cache for API sources; cache tokens in memory; keep stats fresh for ≥ its run time (or one shared stream) | S | Calls in proportion to visible nodes; N× fewer API calls; 2–5× fewer docker processes |
| 10 | **Postgres connects per query** | `sources.rs:617-636, 727` | Keep 1–2 clients per URL, dropped after about 60 s idle | S | −3.3 ms per query, less server churn |
| 11 | **Large diffs are wrong and slow** | `diff/model.ts:93, 130`; `diff-view.tsx:354` | A Myers O(ND) diff; window the review lines | M | Correct diffs; review open in <100 ms *(est.)* |
| 12 | **Palette search grows with the number of chats** | `command-palette.tsx:375` | Rank once per keystroke with `useMemo`, `shouldFilter={false}`, top N, `useDeferredValue` | S | <10 ms per keystroke |
| 13 | **Startup order:** the saved theme applies after the first render, a likely flash *(est.)*. Several Rust commands are synchronous on the main thread | `main.tsx:28-37`; `commands.rs:44, 273`; `data_commands.rs:123` | Cache the theme tokens and apply them from `index.html`; make `list_agents`, `list_sessions` and `general_settings` async | S | No flash; launch never blocks the main thread |
| 14 | **Memory grows with use:** every opened chat's transcript stays in the interface | `use-yaah.ts:25` | LRU-evict transcripts and reload with `get_transcript` (and paginate it) | S–M | Bounded memory over long sessions |
| 15 | **Bundle:** dialogs and views that aren't needed at startup are in the main chunk; there are two copies of immer | see the frontend evidence | Lazy-load them; move `TabSkeleton` out of `settings/parts.tsx`; a pnpm override for one immer | S | −60–80 kB at startup; low priority on desktop |

**Bug found along the way:** whether the transcript stays scrolled to the bottom is shared across chats, because
`Transcript` isn't keyed by session (`chat.tsx:77-79`). Scrolling up in one chat makes the others open at the top and
stop following the stream. Fix: key the Transcript by `sessionId`. Effort S.

**Not a bottleneck:**
- ACP I/O: 1.6M messages/s.
- The UI MCP server: about 100 µs per round trip.
- API client reuse (already one shared client).
- Auto-scroll: about 1 ms per chunk.
- Scrolling, chart updates, tables, trees, JSON and patches.
- The `system` source: 1–3 % of a core at 2 s.
- Idle cost.

## Not measured

- WebKit and WebKitGTK rendering (Chrome only).
- The wall-clock time to window of the real app.
- The JS heap (unavailable in this Chrome).
- The shipped release profile with fat LTO (the benchmarks used codegen-units 16).
