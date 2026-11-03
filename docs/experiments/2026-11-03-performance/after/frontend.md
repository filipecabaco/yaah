# Interface performance: before and after (REVIEW 9, branch `feat/review-1-5-7-8-9`)

3 November 2026. The same measurements as [the review](../frontend/README.md), run again on the code before
this branch's interface changes and after them.

## How it was measured

- **Builds:** the "prodmock" build from [`../frontend/harness`](../frontend/harness) (production React plus the
  browser mock), built twice from `app/src`: once before any change ("before"), once at the end ("after").
  Served with `vite preview`; bundle sizes come from a plain `pnpm build`.
- **Browser:** Chrome driven by vitro, 1440×900, DPR 1, no throttling, Apple-silicon Mac. WebKit wasn't measured.
- **Harness:** [`../frontend/harness/perf-harness.js`](../frontend/harness/perf-harness.js) plus
  [`measure.js`](measure.js) (this folder), loaded into the page with `import()`. They drive the app only through
  the mocked Tauri IPC events and DOM clicks.
- **Chunk timing:** a chunk is timed from the event to React's commit, its effects and any pending layout.
  - "Before" uses `session-entry` (the old protocol: the whole entry each time).
  - "After" uses `session-append` (the new one) and calls the store's flush, so the per-frame batching wait isn't
    counted as cost. The after build was also timed with `session-entry`, the path tool calls and other
    non-append changes take.

## Results

| Area | Measurement | Before | After |
|---|---|---:|---:|
| Streaming | One 24-char chunk at 1k / 10k / 50k characters (mean, ms) | 2.25 / 5.68 / **21.5** | 0.83 / 0.65 / **0.99** |
| Streaming | Same, p95 at 50k (ms) | 26.6 | 1.3 |
| Streaming | After, chunks sent as a whole `session-entry` instead (1k / 10k / 50k, ms) | — | 0.42 / 0.44 / 0.80 |
| Streaming | 45k → 50k, one chunk every 16 ms: fps, long frames | 60 fps, 0 | 60 fps, 0 |
| Streaming | 45k → 50k, one chunk every **2 ms** (208 chunks): wall time, fps, DOM commits | **4,280 ms**, 48.8 fps, 207 | **449 ms**, 60 fps, 25 |
| Background chat | A chunk for a chat that isn't open: 4 chats / 300 chats, 6 shown / 300 chats, all shown (ms) | 0.88 / 0.82 / **9.84** | 0.08 / 0.05 / **0.04** |
| Chat switch | Open a chat of 240 entries (mean of 6, ms) | 127 | **56** |
| Chat switch | Open a chat of 1000 entries (ms; DOM nodes) | 436; 27,012 | **55**; 5,607 |
| Chat switch | Open the heavy agent-UI chat (6 Mermaid diagrams of 10–201 nodes, a map, a 200-row table, a timer), mean / p95 (ms) | 928 / 969 | **72 / 77** |
| Settings | Open the dialog (ms) | 327 | **15** (21 when opened right at startup) |
| Settings | First visit to each tab, mean of 7 (ms) | **318** | **22** (27 right at startup) |
| Settings | A tab visited before (ms) | 18 | 21 (noise) |
| Palette | Items built when it opens, with 330 possible | 330 | 71–76 (top 50 chats) |
| Palette | JS per keystroke, 13 keystrokes, mean / p50 / max (ms) | 11.7 / 7.4 / 34 | **3.0 / 2.3 / 6.4** |
| Palette | Keystroke until the list stops changing, mean (ms; at least 2 frames by construction) | 46 | 41 |
| Diff | A 5000-line file with every 7th line changed: what the diff says | **+4999 −4999** (wrong) | **+715 −715** (exact) |
| Diff | Open its full-screen review (ms; DOM nodes) | 445; 50,052 | **20**; 463 |
| Bundle | Main chunk `index-*.js`, minified (gzip) | 732.9 kB (217.2) | **686.4 kB** (206.3) |
| Bundle | JS loaded at startup: main plus preloaded chunks (gzip, files) | 838.6 kB (257.2, 15) | **775.7 kB** (241.4, 14) |
| Bundle | Chart chunk (Recharts) | 328.9 kB (two copies of immer) | 320.8 kB (one) |
| Bundle | All JS (files) | 5,328.6 kB (129) | 5,342.0 kB (140, more lazy chunks) |

The "before" numbers match the original review within noise. For example, the 50k chunk was 20.7 ms there and
21.5 ms here; the heavy chat was 868 ms there and 928 ms here (with 300 chats in the sidebar).

## What made the difference

- **Streaming:**
  - Each chunk now re-parses only the Markdown block it changes. Earlier blocks are memoised, and a module-wide
    cache keeps parsed blocks across chats.
  - The text arrives as an append (`session-append`) instead of the whole entry.
  - At high rates, events are applied once per animation frame (25 commits for 208 chunks).
- **Background chats:** transcripts live in a store read per chat with `useSyncExternalStore`. A chunk for another
  chat renders nothing at all: no App, no Sidebar. The Sidebar is memoised and gets stable callbacks.
- **Chat switch:**
  - A chat draws its last 200 entries, and earlier ones load as you scroll up.
  - Entries off screen use `content-visibility: auto`.
  - Mermaid SVGs are cached by (theme, text), so reopening a chat doesn't draw them again (about 620 ms of the
    928 ms).
- **Settings:** tab code is fetched when the dialog opens (and when the app is idle). Tabs load through a
  `preloadable` component that renders straight away once its code is in. React.lazy suspends on first render even
  when the code is loaded, which triggered React's 300 ms fallback hold. Tab switches run in `startTransition`.
- **Palette:** built only while it's open; the root page is ranked once per (deferred) keystroke, top 50 only, with
  `shouldFilter={false}`.
- **Diff:**
  - The capped LCS is replaced by Myers' O(ND) diff in linear space, so the diff is exact at any size.
  - The review draws only the rows on screen (fixed 20 px rows, 40 rows of margin).
- **Bundle:** the following are now lazy and fetched on idle:
  - the Component library and project views;
  - the login, new-project and repo-picker dialogs;
  - the diff view and model.

  `TabSkeleton` moved out of `settings/parts.tsx`. A pnpm override (`app/pnpm-workspace.yaml`) leaves one immer.

## Not measured

- **WebKit / WebKitGTK:** expect higher absolute numbers. `content-visibility` and scroll anchoring behave
  differently there (Safari has no scroll anchoring).
- **The real Rust side:** chunks came from the mock, at 24 characters each. Rust now coalesces to one emit every
  ~33 ms, so real chunks are larger and rarer than here.
- **First-ever open of a Mermaid-heavy chat:** the cache helps only from the second draw.

## Screenshots (this folder)

| File | What it shows |
|---|---|
| `csp-01-agent-ui-mermaid-chart-map.jpg` | Agent UI under the release CSP: a Mermaid sequence diagram, a Recharts chart and a Leaflet map. |
| `csp-02-live-sources-chat.jpg` | The recorded "yaah pack" chat (live sources, permissions, test report) under the release CSP. |
| `review8-assembling-card-completed.jpg` | The `ui_render` card after pending → in progress → completed: titled "Deploys", with the UI below. |
| `review8-quote-in-reply-chrome.jpg` | "Quote in reply" after a real mouse-drag selection in Chrome: only the selected text is quoted. |
| `review8-library-640px-list.jpg`, `review8-library-640px-component.jpg` | The Component library in a 640 px window: the list, then a component with "All components" to go back. |
| `review5-integrations-refused.jpg` | Settings → Integrations with GitLab's credential refused: badge, Rust's reason, Reconnect. This capture is from before the reason got its final full stop. |
