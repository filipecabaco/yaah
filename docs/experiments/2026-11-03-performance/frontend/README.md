# Frontend performance review: evidence (2026-11-03)

These files back the frontend performance review of `app/` (Tauri 2, React 19, Vite 8). All browser numbers come from Chrome driven by vitro on macOS (Apple silicon) at 1440×900, DPR 1, with no throttling unless a row says otherwise. WebKit (macOS) and WebKitGTK (Linux) were not measured, so expect different numbers in the shipped app. Every measured value is in `results.json`.

| File | What it shows |
|---|---|
| `results.json` | Every measured number in one place (bundle, startup, streaming per chunk, chat switch, scrolling, agent UI blocks, live sources, interaction latency, leak counters), with how each was taken. |
| `build-output.txt` | Raw output of `pnpm build`: chunk sizes and Vite's warning about chunks over 500 kB. |
| `bundle-attribution.md` | Minified bytes of the main chunk (`index-*.js`), the two largest Mermaid chunks and the lazy chunks (chart, sql, map, diagram, data-table, katex, cytoscape, cli views), attributed to npm packages and app directories through the source maps. |
| `sourcemap-attribution.exs` | The Elixir script that produced `bundle-attribution.md`. It decodes source-map VLQ and adds up bytes per source. Run it as `elixir sourcemap-attribution.exs <chunk.js> [top_n]` on a `vite build --sourcemap` output. Set `DETAIL=1` to list app files one by one. |
| `harness/perf-harness.js` | The in-page harness, loaded with `await import("/perf-harness.js")`. It sends `session-entry` and `session-info` events through the mocked Tauri IPC, just as Rust does, and times chunks (`growth`, `liveStream`), scrolling (`scrollTest`), agent UI renders (`renderUi`) and IPC counts (`countIpc`). |
| `harness/startup.js` | Startup timings read from the page's own buffers: navigation, paint, LCP, long animation frames and resources. |
| `harness/prod-entry.ts`, `harness/app.css`, `harness/prodmock.vite.config.mts` | The "prodmock" build: production React plus `src/dev/browser-mock`, so production-mode rendering can be timed in a plain browser. It needs no app code changes. Build it with `npx vite build --config <scratch>/prodmock/vite.config.mts` from `app/`, then run `vite preview` on port 4174. |
| `01-startup-prod-mock.jpg` | The prodmock build after startup: sidebar and empty state. |
| `02-chat-1000-entries.jpg` | A chat with 1000 synthetic entries (27k DOM nodes) after switching to it. It opened at the top because the "pinned" scroll state carried over from another chat. |
| `03-sidebar-300-chats.jpg` | The sidebar with 300 extra chats, the setup for the per-chunk overhead of whole-app re-renders. |
| `04-diff-review-5000-lines.jpg` | Full-screen diff review of a 5000-line file with every 7th line changed. It renders as +4999 −4999 (whole-file delete and add) because the LCS cell cap was exceeded. 50k DOM nodes, 527 ms to open. |
| `05-component-library.jpg` | The Component library page (32 components). It opens in 24 ms and a component's detail in about 31 ms. |
