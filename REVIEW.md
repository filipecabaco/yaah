# Review: open work items from the research

Updated 3 November 2026 (performance review added). One place to review what the recent research found and what is still to decide or build.
Each item links to its source. Tick an item or write a decision next to it, and it becomes the next task.

**Sources:**
- Research: [`docs/research/`](docs/research/)
- Screenshots and experiment notes: [`docs/experiments/`](docs/experiments/)
- Plan: [`PLAN.md`](PLAN.md)

**State of the code:** the features are committed on `main` as `4a14b72`, after the security fixes in `2695665`. That commit covers:
- component libraries
- brand
- the "Assembling UI" card
- context menus
- projects from tracker items
- GitLab
- teaching agents yaah's UI

All checks pass:
- `cargo fmt`
- `clippy -D warnings`
- Rust: 149 lib tests, plus the acp_e2e, docker and postgres suites
- `cargo deny`
- `pnpm check`: 116 tests
- `pnpm build`

The performance review (section 9) is research only: it changed no app code.

---

## 1. Agents using yaah's UI

Sources: [component-model-review.md](docs/research/component-model-review.md);
experiments [before](docs/experiments/2026-11-03-component-model-live-test/) and
[after](docs/experiments/2026-11-03-agent-guide-live-test/).

**Result.** After teaching agents about yaah, Sonnet used yaah's UI in **5 of 6** prompts, up from 2 of 6. Codex used it in **3 of 3**.

**How agents are taught.** yaah ships one skill set in the open Agent Skills format and delivers it the same way to every agent:
- its MCP server: `ui_guide`, plus the skills as resources and prompts;
- the ACP `systemPrompt`, when the agent supports it;
- a fallback in the chat's first prompt.

Claude's plugin is an optional extra on top.

- [ ] **PDF is the one miss.** The agent said yaah has no PDF viewer and rendered nothing. Fixed by item 2.2 below (not in this round).
- [x] **Full tool names.** The guide, the MCP instructions and both skills give every tool as `mcp__yaah-ui__ui_catalog` and as `ui_catalog`; the list is generated from `ui_mcp::TOOL_NAMES`.
- [ ] **Gemini not measured:** Gemini CLI isn't signed in on this machine. How to run it is in [gemini.md](docs/experiments/2026-11-03-agent-guide-live-test/gemini.md) (`run_turns_as`, temp profile store).
- [x] **Codex skills: decided to stay on the generic routes** (no `.agents/skills` trusted root). Written up in the README, "What agents are told".
- [x] **Save-component errors** name the field (`examples[0].title is required…`). JSON sent as strings is accepted, a plain-string `tree` is refused clearly, and every tool error also returns `structuredContent.errors: [{path, message}]`.

## 2. Component model: what to build next

Source: [component-model-review.md → "What to do"](docs/research/component-model-review.md#what-to-do-merged-ranking) (ranked, with effort and security impact).

- [ ] **2.1 Serve media from the preview server.** pdf, mp4, webm, mp3, vtt, glb, with HTTP Range support. Without it, local video and PDFs fail without an error. (S–M)
- [ ] **2.2 A `pdf` primitive** (pdf.js: page, find, highlight). (M)
- [ ] **2.3 A `video`/`audio` primitive** (captions, chapters, `at`), plus `media-src` in the CSP. (M)
- [ ] **2.4 A `slides` primitive and a controlled `tabs`**, so the agent can say "go to slide 3". Codex already improvised slides from buttons. (M)
- [ ] **2.5 Progressive-disclosure catalog.** `ui_catalog` is about 9k tokens and grows with every installed library. (M)
- [ ] **2.6 Library `requires` / `fallback`**, and a clear "unknown primitive" error. (S)
- [ ] **2.7 Catalog honesty tests:** every primitive has a renderer, and every `uses` resolves to a dependency. (S)
- [ ] **2.8 Standard formats for new visual primitives:** Vega-Lite, GeoJSON, Excalidraw, glTF. (M each)
- [ ] **2.9 Data-only updates by `id`** (`ui_update`), and streaming if ACP exposes partial tool input. (M)

## 3. Standards: MCP Apps and A2UI

Source: [component-model-review.md → Prior art](docs/research/component-model-review.md#prior-art-condensed).

**Today:** yaah's `ui_render` is its own JSON tree format (the A2UI / ChatKit family). It doesn't comply with MCP Apps or A2UI.

- [ ] **Decide:** add a sandboxed `app` node that speaks the **MCP Apps** view protocol. That gives kanban drags, whiteboards, games and 3D a two-way channel, and lets library widgets run in Claude, ChatGPT and VS Code too. Effort L. Prerequisite: a separate origin per chat or library (all previews share one origin today).
- [ ] **Decide:** may git component libraries ship widgets (`code: true`, sandboxed only)? Never as code inside the app.
- [ ] **Investigate:** can yaah show third-party MCP Apps? Claude Code, not yaah, is the MCP client for the agent's other servers. Check whether ACP passes their `_meta.ui` through.
- [ ] **Later, optional:** import A2UI, so A2UI-speaking agents can render in yaah.

## 4. Integrations

Source: [integrations-shortlist.md](docs/research/integrations-shortlist.md).

- [x] **Decided (2026-11-03): no new integrations for now.** The focus is **GitHub, GitLab and Linear**, done well. The shortlist (Sentry, GitHub Actions, Jira, PagerDuty, Vercel, Notion, Slack, a generic MCP OAuth client) stays as research for later.

## 5. Projects from tracker items

Sources: [codrift-issue-import.md](docs/research/codrift-issue-import.md), [work-items-contract.md](docs/research/work-items-contract.md),
[screenshots](docs/experiments/2026-11-03-projects-from-issues/).

**Built:** GitHub issues, Linear issues and projects, GitLab issues; pasting a URL or id works; local clones are matched; a chat opens with the prompt drafted; a live item on the project page; refresh and unlink. No branches (your choice).

- [x] **Real run against Linear** (read-only, your connection, `live_linear_queue_resolve_and_sources`, `#[ignore]`). All four GraphQL assumptions hold, and the queue returned 62 issues. Comments come newest first; that order is now explicit (`orderBy: createdAt`).
- [x] **Refused credentials show as refused.** A 401 (GitLab: 403 `insufficient_scope`; Linear: `AUTHENTICATION_ERROR`) on GitHub, GitLab or Linear marks the credential refused. Settings then shows a "Credential refused" badge, the reason, and Reconnect, until a call works or you reconnect.
- [x] **`owner/repo#12`** stays GitHub unless only GitLab is connected (kept).
- [x] **Relation filter** kept as is.
- [ ] **GitLab OAuth needs an app.** Register one (redirect `http://127.0.0.1:43117/oauth/callback/gitlab`, not confidential, scopes `read_api read_user`) and set `YAAH_GITLAB_CLIENT_ID`. Tokens work today without it.

## 6. Component libraries

Source: [component-libraries-contract.md](docs/research/component-libraries-contract.md); README "Component libraries".

- [ ] **Never tried in the running app.** Tested only by Rust tests and the UI mock. Try "Share as library…", then install the folder from Settings → Components.
- [ ] **No public library or curated index exists yet.** Do we want one, or is git enough?

## 7. Security

Source: [security-review.md](docs/research/security-review.md). All 9 findings are fixed in `2695665`.

- [ ] **OAuth client ids** for GitHub and Linear are codrift's registered apps. Register yaah's own before shipping.
- [x] **Release CSP tested.** `app/scripts/csp-serve.exs` serves a build with the policy rebuilt the way Tauri does it (script hashes). No violations across recorded chats, agent UI (Mermaid, charts, maps, CodeMirror, diffs), Settings, the Component library and diff review.
  - **Found and fixed:** Tauri's default style-src nonce would have broken inline styles (Mermaid SVG) in release only, so it's disabled (`dangerousDisableAssetCspModification: ["style-src"]`). A test guards it.
- [x] **`localhost` dev servers** are allowed in `frame-src`, because Vite often binds only `::1`. Tested against the real config.
- [x] **One preview origin per chat:** each chat gets its own `127.0.0.1` port, opened on first preview and closed when the chat is deleted.
- [x] **UI tokens expire** when a chat is deleted (scoped to the chat's own hub).
- [x] **MCP secrets reach Settings masked** (`••••1234`); an unchanged masked value keeps the secret.
- [ ] **Still informational:** the broad GitHub `repo` scope, unpinned transitive adapter dependencies (now `npm audit`ed), image-URL leaks from previews.
- [ ] **Your `shop` Postgres connection** signs in as a superuser and is now refused. Create the `yaah_ro` role (README → Live sources).

## 8. Brand and interface: needs a look in the real app

Screenshots of earlier UI checks: [earlier-ui-checks](docs/experiments/earlier-ui-checks/).

- [ ] **Brand:** the four-tile mark (sidebar, home, app icon from `src-tauri/icons/source/icon.svg`) and the start-up sliding-logo loader (`index.html`). The loader is meant for the website later. Approve the mark and colour?
- [x] **The "Assembling UI" card,** checked through a recorded `ui_render` (pending → in progress → done) in the mock, with a test. "Assembling UI" with a spinner, then "Deploys".
- [ ] **"Quote in reply"** quoted exactly a real mouse selection in Chrome. Still to check in WebKit, the real app, which selects the word under the pointer.
- [x] **The Component library page below 700 px** shows one pane at a time, with "All components" to go back (a container query).
- [x] **Streamed messages no longer slow down** as a reply grows (see 9.1).

## 9. Performance

Source: [performance-review.md](docs/research/performance-review.md) (measured numbers, file:line, effort, expected gain);
evidence in [docs/experiments/2026-11-03-performance/](docs/experiments/2026-11-03-performance/).

yaah is fast at rest (0 % CPU idle, first paint about 20 ms, smooth scrolling, no leaks). The costs grow with use:

All done on `feat/review-1-5-7-8-9`. Measured results are in [after/](docs/experiments/2026-11-03-performance/after/)
(`rust-sessions.md`, `rust-sources.md`, `frontend.md`); the event shapes are in [streaming-contract.md](docs/research/streaming-contract.md).

| Item | Before | After |
|---|---|---|
| 9.1: IPC / Rust time for a 200k-character reply | 507 MB / 205 ms | **0.24 MB / 4.6 ms** (`session-append` deltas, coalesced to about 30/s) |
| 9.1: interface cost per chunk at 50k characters | 21.5 ms | **0.99 ms** (Markdown memoised per block, updates once per frame) |
| 9.2: another chat's p99 while a 28 MB chat takes edits | 14.5 ms | **2.5 µs** (per-chat locks, lazy saves; form edits send only the draft: 1 MB → 193 B) |
| 9.3: launch blocked on the login-shell PATH | 1.2–1.5 s | **≈ 0** (read in the background); loading 100 chats 133 → 3.7 ms (lazy transcripts) |
| 9.4: opening a heavy agent-UI chat / a 1000-entry chat | 928 / 436 ms | **72 / 55 ms** (Mermaid SVG cache, `content-visibility`, last 200 entries) |
| 9.5: a background chat's chunk, 300 chats in the sidebar | 9.84 ms | **0.04 ms** (a store per chat with `useSyncExternalStore`; zero App commits) |
| 9.6: first visit to a Settings tab | 318 ms | **22 ms** (preloading) |
| 9.7: `ui_catalog`, guide per Claude chat | 12 ms, 22 ms | **< 1 µs, 0.1 ms** (in-memory library, checked every 2 s) |
| 9.8: agent start | 808 ms | **129 ms** (done earlier: installed once, run with node) |
| 9.9: 5 identical GitHub reads; Postgres query; offscreen live views | 5 requests; 4.2 ms; kept polling | **1 request** (dedup + 5 s cache); **1.2 ms** (pool); **paused off screen**, read at once when back |
| 9.10: 5000-line diff | wrong (+4999 −4999), 445 ms | **exact (+715 −715), 20 ms** (Myers, windowed review) |
| 9.11: palette per keystroke; theme flash; memory; startup JS | 11.7 ms; flash; unbounded; 838 kB | **3.0 ms; none; 8 transcripts kept; 776 kB** |
| Bug: "stay at bottom" shared across chats | shared | **per chat** (`Transcript` keyed by session; a test fails without it) |

- [x] 9.1–9.11 and the bug, each with tests: 201 Rust unit tests plus the e2e, Docker and Postgres suites; 199 frontend tests.

## 10. Agent adapters: installs, versions and conformance

Sources:
- `app/src-tauri/src/agent_install.rs`, `agent_versions.rs`, `agent_conformance.rs`
- [agent-install numbers](docs/experiments/2026-11-03-performance/backend/agent-install.md)
- [CI in Docker](docs/experiments/2026-11-03-ci-docker/)

**Built:**
- npm-based adapters are installed once into `~/.yaah/agents/` and run with `node`: start to ready went from 808 ms to 129 ms, memory from 313 MB to 128 MB.
- A daily registry check installs newer versions as candidates.
- **Tier A conformance** (no sign-in) plus `npm audit` must pass before a candidate is promoted.
- "Hold at this version" and "Verify now" are in Settings → Agents.

Tier A results (pinned and latest):

| Adapter | Pinned | Latest | Note |
|---|---|---|---|
| claude | 0.99.1 ✓ | 0.100.0 ✓ | 0.100.0 will be promoted |
| codex, gemini, copilot, auggie | ✓ | same | No advisories |
| qwen | 0.26.5 blocked | 0.26.6 blocked | High advisory: GHSA-wq5f-xc86-pv6w (sharp/librsvg) |
| cline | 3.0.74 blocked | same | 2 critical (simple-git), 9 high (undici, zod, busboy) |

- [ ] **qwen and cline** are blocked by advisories in both their pinned and latest versions. Keep offering them with a warning, or hide them until fixed upstream?
- [ ] **Tier B (live prompts)** is defined as 7 checks wired as ignored tests, plus a disabled setting. To enable it: run it against real accounts, tune the prompts, flip `live::ENABLED`, and decide what happens with no signed-in profile (currently: promote with a note).
- [ ] **Keychain access:** conformance runs in throwaway homes, but on macOS an adapter could still read the login keychain. None did. Accept, or sandbox further?

## 11. CI, releases and installer

Sources: [CI in Docker](docs/experiments/2026-11-03-ci-docker/), `ci/`, `app/mise.toml`.

- [x] **Local CI:** `mise run ci` (rust, web, conformance), the same commands in an Ubuntu 24.04 container (`mise run ci:docker`). Green; 65 s warm, about 3 min cold.
- [x] **GitHub CI is on** (`.github/workflows/ci.yml`), green on the first push. Its actions are verified on node24: checkout v7, mise-action v5 (mise pinned), rust-cache v2, upload-artifact v7. It includes a nightly conformance run against the latest adapters.
- [ ] **Docker/Postgres tests are skipped** in the container (no daemon or database there). Add service containers in GitHub CI?
- [ ] **The container is arm64 on this Mac,** while GitHub's `ubuntu-latest` is x86_64; x86_64 has only been checked on GitHub's side in theory.
- [x] **Installer built and tested locally** ([results](docs/experiments/2026-11-03-installer/)):
  - `install.sh` with checksum verification, macOS arm64 (ad-hoc signed, quarantine removed after verification), Linux AppImage or `--deb`, and `--uninstall`/`--purge`/`--dry-run`;
  - the release workflow draft `.github/workflows/release.yml` (node24 verified);
  - mise tasks `release:build`/`release:checksums`/`release:linux:docker`.
- [x] **First release cut:** [v0.1.0](https://github.com/filipecabaco/yaah/releases/tag/v0.1.0), public repo [filipecabaco/yaah](https://github.com/filipecabaco/yaah); CI and release workflows live, and the one-liner was tested against the real release on macOS and Ubuntu.
- [ ] **The AppImage on a bare server** needs the usual desktop libraries (X11, GL, fontconfig). The installer explains this; it's fine on a desktop.
- [ ] **Later:** Apple Developer ID signing and notarisation; in-app updates; Homebrew.

## 12. Website

Source: `site/` (Astro; `pnpm dev`); screenshots in [2026-11-03-website](docs/experiments/2026-11-03-website/).

- [ ] **Review the site:** one page with the opening, 12 features with real screenshots, 4 "you ask, the agent renders" examples with real JSON, how it works, build from source, and not there yet. It matches the app's look.
- [x] **Updated for the release:** install one-liner, GitHub and Releases links, adapter version management, canonical URL and social image.
- [x] **Hosted** on GitHub Pages at https://filipecabaco.github.io/yaah/ (`.github/workflows/site.yml`, node24 actions).

## 13. Housekeeping

- [x] **Committed** as `4a14b72`; the performance review and these doc updates are not committed yet.
- [ ] **`src-tauri/src/live_ui_review.rs`** (the live UI test, `#[ignore]`) is now in the repo. Keep it?
- [ ] **`PRODUCT.md`** (the design-context file) is in `app/`. Keep it?
