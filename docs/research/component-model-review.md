# Agent-built UI: component model review

3 November 2026. Two parts:
- a review of yaah's own model, with a live test against Claude Sonnet 5.5 through the `claude-personal` profile;
- a survey of prior art.

This is a decision record for later work; nothing here is implemented yet.

## Answers in brief

- **Is defining components as JSON common?** Yes, and it is the oldest pattern in this space: Adaptive Cards, Slack Block Kit, server-driven UI at Airbnb, Lyft and Yandex (DivKit). The newest agent specs do it too: Google's A2UI, Vercel's json-render, OpenAI's ChatKit widgets, Thesys C1 / OpenUI. yaah's "nested tree of primitives, saved as a template with a JSON Schema and examples, no agent code" sits squarely in that family. ChatKit's `.widget` (template + data schema + example) is almost the same as a yaah component.
- **Where the field is going.** Hosts mix three tiers:
  1. **Controlled:** a tool maps to a component the app ships.
  2. **Declarative:** JSON over a catalog (A2UI, yaah).
  3. **Open-ended:** sandboxed HTML in an iframe. The standard here is **MCP Apps** (SEP-1865, Final January 2026), shipped by Claude, ChatGPT, VS Code, Goose, Postman and M365 Copilot.

  Nobody bets on one tier only.
- **New JS libraries.** A primitive's library must be bundled into the app. A git library that uses a primitive yaah doesn't have fails with a misleading error, and can't declare what it needs. Libraries should never ship code that runs in the app; if they need JS, it belongs in a sandboxed tier.
- **Exotic UIs.** Anything the agent only *shows* (3D, canvas, slides, whiteboards, games) already works through `browser` previewing a local HTML page. It's one-way: user actions (drag a card, draw) never reach the agent.
- **Video and PDF** fail without any error today (details below).
- **Interactive presentations** are possible only as HTML in `browser` (not drivable by the agent) or as tabs (uncontrolled, with no next/previous or notes).

## Live test (Sonnet 5.5, `claude-personal`, 6 prompts, one try each)

| # | Prompt | What the agent did | Result in yaah |
|---|---|---|---|
| 1 | 5-slide interactive presentation | Wrote `release-plan.html`, tried `open` | Nothing (works by hand through `browser`) |
| 2 | Play a local mp4 | `open <mp4>` | Nothing |
| 3 | Show a PDF, point at page 2 | `ToolSearch` → `ui_catalog` → HTML with `<embed src="file://…">` → `ui_render` `browser` | Validated, but the frame can't show the PDF |
| 4 | 3D rotating cube | Elixir terminal script (the profile's CLAUDE.md says scripts are Elixir) | Nothing |
| 5 | Draggable kanban | Wrote `index.html` | Nothing; drags couldn't reach the agent anyway |
| 6 | Save and render a release-checklist component | `ui_save_component` ×4 (3 failures), then rendered | Worked on the fourth try |

**Main finding.** The agent used yaah's UI in 2 of 6 prompts. Claude Code defers MCP tools behind `ToolSearch`, and yaah's server instructions (`ui_mcp.rs:23`) never mention showing, playing, presenting or interactive work. So the agent reaches for `open`, standalone HTML or the user's own conventions. This matters more than any missing primitive.

The test lives outside the app (`live_ui_review.rs`, an `#[ignore]` test meant to be `include!`d in `session.rs`'s `mod live_tests`, reusing `run_turns`). It also found a harness bug: `harness_allows` compares paths against an uncanonicalised `temp_dir()`, which is `/var/…` versus `/private/var/…` on macOS.

## Findings by question (file:line references as of this date)

### Adding a primitive that needs a new library
- **The steps:**
  - declare it in `src/ui-primitives.json` (Rust `include_str!`s it, `ui_library.rs:31`);
  - add a renderer `case` in `ui-render.tsx:135-457` with a lazy block (`:31-45`);
  - add the npm dependency;
  - extend the CSP if the library fetches anything (`tauri.conf.json:21-31`);
  - add special cases where needed (`ui_files.rs`, `reads_of` in `ui_libraries.rs:645-667`).
- **`uses` is informational only.** Nothing loads code from it or checks it against `package.json`.
- **No test** checks that every primitive has a renderer `case`.
- **Validation is shallow.** Rust checks prop names, top-level types and enums, but not shapes inside arrays and objects (map markers, chart series); the renderer silently drops bad items.
- **A git library using an unknown primitive** gets the wrong hint from `Scope::resolve` (`ui_libraries.rs:603-622`), and that component and every sibling using it fail to load.

### Exotic UIs
- **Exists:** `map` (Leaflet, markers only; no lines, polygons or GeoJSON); Mermaid `diagram` for Gantt, timelines and graphs (static, no clicks); read-only boards (`linear-board`).
- **Kanban by composition:** columns from `grid` + `each`, with a status `select` inside a `form`. No drag.
- **Canvas, whiteboard, 3D and games:** only through `browser` (CDN scripts and WebGL are allowed in the preview). One-way: nothing in `src/` listens for `postMessage`, and the preview CSP is `connect-src 'self'`.

### Video
- **No primitive.** `image` handles png, jpg, gif, webp and svg only (`ui_files.rs:27-37`, `ui-render.tsx:438`).
- **The preview server can't play local video:**
  - its allowlist (`ui_mcp.rs:544-566`) has no mp4, webm, mp3 or vtt;
  - `serve_preview` uses `Response::from_file` with no `Range`/206 support (`:532`), which WebKit needs for mp4.
- **The app CSP has no `media-src`.** Remote video works inside a preview page and is blocked in the app document.

### Slides
- `tabs` is uncontrolled (`defaultValue="0"`, `ui-render.tsx:412-433`): re-rendering keeps the user's tab, so the agent can't say "go to slide 3". There are no next/previous controls, notes or fullscreen.
- reveal.js-style HTML through `browser` works well, keyboard included, but the agent can't drive it.

### PDF
- **Not served or inlined:** `pdf` isn't in the preview allowlist or `ui_files::mime`.
- **Blocked in the app:** the app CSP has `object-src 'none'`.
- **Inside a preview page:** the double sandbox (the iframe attribute and the CSP `sandbox`) blocks WebKit's PDF plugin, and WebKitGTK on Linux has no PDF viewer at all. Use pdf.js everywhere.

### Robustness
- **Catalog size.** `ui_catalog` returns about 35k characters (about 9k tokens): 45 primitives plus 20 components, growing linearly with installed libraries (up to 500 components each).
  - Prior art: Anthropic's on-demand tool loading took accuracy from 49% to 74% (Opus 4), and tool input examples from 72% to 90%. RAG-MCP shows selection accuracy falling as pools grow.
- **Errors.** `ui_render` errors are good: path, allowed props, enums. `ui_save_component` returns raw serde errors (`ui_mcp.rs:349-351`): "missing field `title`" meant `examples[].title`, and cost the agent 3 calls.
  - A string `tree` is accepted by `ui_render` but not by save, where it would become a text node (`ui_library.rs:248`, `:707`).
- **No streaming.** The tree appears only after the whole call validates; the card says "Assembling UI" until then.
- **Large trees.** Caps are 3000 nodes, depth 30, 3000 expanded nodes, 8 nesting levels and an 8 MB body. Rows aren't virtualised; `table` paginates past 25.
- **Previews share one origin.** All previews share `http://127.0.0.1:<port>`, so localStorage and IndexedDB are shared between them. This matters before any third-party widget.
- **`localhost` dev servers in `browser`** are likely blocked in release builds. `frame-src` only allows `127.0.0.1:*`, and dev builds don't apply a CSP (`devCsp: null`), so it doesn't show up in development.

## Prior art (condensed)

| System | Model | Extensibility | Actions back | Streaming | Notes for yaah |
|---|---|---|---|---|---|
| Adaptive Cards | JSON over a catalog | Host renderer SDKs | `Action.Execute` | No | Card `version` + element `fallback`: copy this |
| Slack Block Kit | JSON over a catalog | None | `block_actions` | No | Has `video`, `data_table`, `plan` blocks |
| A2UI (Google) | Flat list with ids | Custom catalogs | `action` events, v1.0 RPC | JSONL | v0.9 went "prompt-first" because strict structured output limited catalog size |
| json-render (Vercel) | Flat map | Zod catalogs; packs for shadcn, R3F 3D, Remotion video, react-pdf | `emit`, state | JSONL patches | Exotic output can stay declarative over a component library |
| ChatKit widgets (OpenAI) | JSX templates → JSON | Template files | `onAction` | Yes | Almost the yaah component model |
| MCP Apps / MCP-UI | Sandboxed HTML iframe | Anything | JSON-RPC over postMessage | `tool-input-partial` | The standard escape hatch; examples include a PDF viewer, video, a 3D globe |
| Retool / Appsmith | App JSON | **Custom components in iframes** with a model/event bridge | Events | No | Prior art for a sandboxed extension point |
| Jupyter | MIME bundles + widgets | Renderer extensions, anywidget ESM | Comms | Output updates | MIME bundle = the cleanest fallback idea |
| tldraw / Excalidraw | Scene JSON | Code shapes | Agent action kits | Yes | Models shouldn't write raw scene formats; use skeletons |

**JSON versus HTML.** No eval compares the two on the same tasks.
- HTML wins one-shot preference (Google's Generative UI paper) but is slow: up to a minute per page.
- HTML is weak over several turns: EvoGenUI-Bench completes only 37% of 5-turn episodes.
- Catalog JSON reaches 83–97% validity with a 70-component catalog (a vendor benchmark, Thesys). Nested or `type`-discriminated formats did best; flat id graphs did worst.
- Data is the better medium for UI that lives on (updated, bound to live data, filled in together, saved, themed), which is yaah's core use. It is also several times cheaper in tokens.

Sources are linked in the original research. Key ones:
- [MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
- [A2UI v0.9](https://a2ui.org/specification/v0.9-a2ui/)
- [json-render](https://github.com/vercel-labs/json-render)
- [ChatKit widgets](https://developers.openai.com/api/docs/guides/chatkit-widgets)
- [Anthropic advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- [Generative UI paper](https://arxiv.org/abs/2604.09577)
- [EvoGenUI-Bench](https://arxiv.org/abs/2608.29387)
- [Thesys bench](https://github.com/thesysdev/Generative-ui-bench)

## What to do (merged ranking)

| # | Action | Effort | Security impact |
|---|---|---|---|
| 1 | **Make agents use yaah's UI.** Name "show / play / present / interactive" in the MCP instructions ("never `open`"), add a one-line hint to the first-prompt preamble, and check whether Claude Code can keep `yaah-ui` tools loaded rather than deferred. Re-run the live test to measure. | S | None |
| 2 | **Fix `ui_save_component` errors.** Map serde errors to paths (`examples[0].title is required`), accept string `tree`/`examples` like `ui_render`, and return `{path, message}` errors everywhere. | S | None |
| 3 | **Progressive-disclosure catalog.** An index plus a core of about 15 primitives, `ui_describe(names)` for detail, one example per primitive, search once libraries grow. | M | None |
| 4 | **Preview server media.** Add pdf, mp4, webm, m4v, mp3, wav, ogg, vtt, glb and gltf, with HTTP Range/206 support. | S–M | Low (still only the page's folder) |
| 5 | **`pdf` primitive** (pdf.js, lazy): `page`, `find`, `highlight`, current page readable through `ui_get_values`. Needs `worker-src`. | M | Low |
| 6 | **`video`/`audio` primitive:** `src` (local served with Range, https, allowlisted embeds), `poster`, `captions`, `chapters`, `at` to seek, current time readable. Needs `media-src`; remote waits for a click. | M | Low |
| 7 | **`slides` primitive and a controlled `tabs`.** Children are yaah subtrees, a `---` markdown shortcut, notes, present mode, `at`, current slide readable. | M | None |
| 8 | **Library versioning.** `requires` (yaah version and primitives) in the manifest, a clear "unknown primitive" error, `fallback` on nodes, `catalogVersion` in `ui_catalog`. | S | None |
| 9 | **Catalog honesty tests.** Every primitive has a renderer case; every `uses` resolves to a dependency. | S | None |
| 10 | **Standard specs for new visual primitives:** Vega-Lite (`vega`), GeoJSON layers on `map`, Excalidraw skeleton for a two-way `whiteboard`, glTF for a `model` viewer. | M each | Low |
| 11 | **Sandboxed `app` node speaking the MCP Apps view protocol.** Separate origin per chat or library, `connect-src 'none'`, Load gate, required `fallback`, bridge limited to `ui/message`, model context, size and theme; values flow into form drafts so `ui_get_values` works. Git libraries may ship widgets *only* here (`code: true` in the manifest, shown at install). Makes drag, whiteboards, games and 3D two-way. | L | Medium (needs per-origin isolation) |
| 12 | **Data-only updates by `id`** (`ui_update(id, patch)`), and streaming of partial tool input if ACP exposes it. | M | None |
| 13 | **Small fixes.** Allow `localhost` in `frame-src` (or rewrite it to 127.0.0.1); canonicalise the temp root in the live-test harness. | S | Neutral |
| 14 | Investigate hosting third-party MCP Apps (blocked: Claude Code, not yaah, is the MCP client of the agent's other servers). | L | — |

**Don't:**
- run library JS inside the app origin (it would get every Tauri command);
- adopt flat id-graph formats;
- adopt Remote DOM;
- make the HTML escape hatch the default.
