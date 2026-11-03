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

- [ ] **PDF is the one miss.** The agent said yaah has no PDF viewer and rendered nothing. Fixed by item 2.2 below.
- [ ] **Unprefixed tool names.** The agent called `ui_catalog`/`ui_guide` without the `mcp__yaah-ui__` prefix and got "No such tool" twice. Should the guide spell out the full names, or is this agent-specific?
- [ ] **Gemini not measured.** Gemini CLI 0.63 gets the first-prompt fallback but wasn't measured, because it needs a yaah agent profile. Add one and run the live test (`src-tauri/src/live_ui_review.rs`, `#[ignore]`).
- [ ] **Codex skills.** Codex can only load skills from `<extra dir>/.agents/skills`, which would make that folder a trusted, writable root. It was not done; Codex uses the generic routes. Decide whether that's acceptable.
- [ ] **Save-component errors** are still raw serde messages. The guide avoided them in the test, but they're unfixed ([review](docs/research/component-model-review.md), item 2).

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

- [ ] **Pick what comes next.** Recommended: **Sentry issues** (device flow, S–M) and **GitHub Actions runs and logs** (existing token, S).
- [ ] **Decide:** a generic MCP OAuth client (DCR + PKCE). It would unlock Notion, Atlassian (Jira, Confluence) and Datadog through their hosted MCP servers, since their REST APIs have no public client.
- [ ] **Jira:** API token now, or wait for Rovo MCP?
- [ ] **PagerDuty / Vercel / Slack:** each has an auth caveat; see the table.

## 5. Projects from tracker items

Sources: [codrift-issue-import.md](docs/research/codrift-issue-import.md), [work-items-contract.md](docs/research/work-items-contract.md),
[screenshots](docs/experiments/2026-11-03-projects-from-issues/).

**Built:** GitHub issues, Linear issues and projects, GitLab issues; pasting a URL or id works; local clones are matched; a chat opens with the prompt drafted; a live item on the project page; refresh and unlink. No branches (your choice).

- [ ] **First real run against Linear.** Four GraphQL assumptions are untested (`ProjectFilter.status.type`, `members.some.isMe`, `project(id:)` taking a slugId, `Project.content`). The newest comments may be missing on issues with more than 30.
- [ ] **A revoked GitLab token still shows "Connected"** in Settings, while the picker says the token was refused. Show the refusal in Settings too?
- [ ] **`owner/repo#12` is ambiguous** between GitHub and GitLab. It means GitHub unless only GitLab is connected. OK?
- [ ] **Relation filter:** "Assigned" includes Linear projects you lead; projects where you're only a member appear only under "All". OK?
- [ ] **GitLab OAuth needs an app.** Register one (redirect `http://127.0.0.1:43117/oauth/callback/gitlab`, not confidential, scopes `read_api read_user`) and set `YAAH_GITLAB_CLIENT_ID`. Tokens work today without it.

## 6. Component libraries

Source: [component-libraries-contract.md](docs/research/component-libraries-contract.md); README "Component libraries".

- [ ] **Never tried in the running app.** Tested only by Rust tests and the UI mock. Try "Share as library…", then install the folder from Settings → Components.
- [ ] **No public library or curated index exists yet.** Do we want one, or is git enough?

## 7. Security

Source: [security-review.md](docs/research/security-review.md). All 9 findings are fixed in `2695665`.

- [ ] **OAuth client ids** for GitHub and Linear are codrift's registered apps. Register yaah's own before shipping.
- [ ] **CSP is untested in a release build** (`pnpm tauri build`); dev builds don't apply a CSP.
- [ ] **`localhost` dev servers in `browser`** are probably blocked in release (`frame-src` only allows `127.0.0.1`).
- [ ] **Previewed pages share one origin**, so their storage is shared. Fix this before any third-party widget (item 3).
- [ ] **Other informational items:** the broad GitHub `repo` scope, MCP secrets over IPC, UI tokens that never expire, unpinned npx dependencies, image-URL leaks from previews.
- [ ] **Your `shop` Postgres connection** signs in as a superuser and is now refused. Create the `yaah_ro` role (README → Live sources).

## 8. Brand and interface: needs a look in the real app

Screenshots of earlier UI checks: [earlier-ui-checks](docs/experiments/earlier-ui-checks/).

- [ ] **Brand:** the four-tile mark (sidebar, home, app icon from `src-tauri/icons/source/icon.svg`) and the start-up sliding-logo loader (`index.html`). The loader is meant for the website later. Approve the mark and colour?
- [ ] **The "Assembling UI" card:** a spinner while an agent builds UI or stores a component, then the UI's title. Check it in a live chat (only unit-tested so far).
- [ ] **"Quote in reply"** reads the selection at right-click. Check it in WebKit, which selects the word under the pointer.
- [ ] **The Component library page** is cramped below about 700 px wide (two fixed-width side columns).
- [ ] **Streamed messages** slow down as a reply gets long (cost grows with the square of its length).

## 9. Performance

Source: [performance-review.md](docs/research/performance-review.md) (measured numbers, file:line, effort, expected gain);
evidence in [docs/experiments/2026-11-03-performance/](docs/experiments/2026-11-03-performance/).

yaah is fast at rest (0 % CPU idle, first paint about 20 ms, smooth scrolling, no leaks). The costs grow with use:

- [ ] **9.1 Long replies cost O(n²).** A 200k-character reply sends 507 MB from Rust to the interface, and each chunk re-parses all the Markdown (about 21 ms per chunk at 50k). Fix: emit only the new text, coalesce emits, and use Markdown memoised per block. **Highest impact.** (M, both sides)
- [ ] **9.2 Saves block every chat.** The whole transcript is serialised under one global lock (another chat's p99 goes from 18 µs to 12 ms). Fix: per-session locks and lazy saves. (M)
- [ ] **9.3 Launch waits 0.7–1.3 s for the login-shell PATH.** Fix: read it in the background, and load transcripts lazily. (S/M)
- [ ] **9.4 Opening a chat redraws everything** (heavy chat 868 ms, mostly Mermaid). Fix: an SVG cache and `content-visibility`. (S–M)
- [ ] **9.5 Every chunk re-renders the whole app,** even for background chats. Fix: a per-session store. (M)
- [ ] **9.6 First visit to a Settings tab or lazy UI waits 300 ms.** Fix: preload. (S)
- [ ] **9.7 The component library is re-read on every call** (catalog 15 ms, `session/new` +22 ms with a large library). Fix: an in-memory cache. (M)
- [ ] **9.8 Agents start through `npx -y`** (+280 ms, +115 MB each). Fix: run the cached binary. (S–M)
- [ ] **9.9 Live sources over-poll** (offscreen nodes, duplicate API reads, `docker.stats` takes 2 s but is shared for 1 s), and **Postgres connects per query** (+3.3 ms). (S each)
- [ ] **9.10 Large diffs are wrong above the LCS cap** (+4999 −4999) and slow to review. Fix: Myers diff and windowing. (M)
- [ ] **9.11 Smaller items:** palette search per keystroke, theme flash at startup, transcripts never evicted, bundle trims. (S each)
- [ ] **Bug:** "stay at bottom" is shared across chats (`chat.tsx:77-79`). Fix: key `Transcript` by session. (S)

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
- [x] **GitHub CI is on**: move `.github/workflows/ci.yml` into `.github/workflows/`. Its actions are verified on node24: checkout v7, mise-action v5 (mise pinned), rust-cache v2, upload-artifact v7. It includes a nightly conformance run against the latest adapters.
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
