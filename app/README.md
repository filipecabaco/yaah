# yaah — chat PoC

A Tauri + React + shadcn proof of concept: group folders into projects, pick a Claude account, chat with Claude Code over ACP.

## Run

```sh
pnpm install
pnpm tauri dev
```

Needs Rust, Node (for `npx`) and a logged-in Claude Code account. macOS and Linux only.

## How it works

```
React (src/)                 Rust (src-tauri/src/)                  agent process
-------------                ---------------------                  -------------
invoke(new_session) ───────► session.rs  Hub ─── acp.rs ── stdio ──► npx @agentclientprotocol/claude-agent-acp@0.99.1
render entries     ◄──────── "session-entry" / "session-info" events     (env CLAUDE_CONFIG_DIR=<account>)
```

- **acp.rs** — minimal ACP v1 client: newline-delimited JSON-RPC over the agent's stdio, request/response correlation, agent-initiated requests.
- **session.rs** — one adapter process per account, many sessions per process. Merges `session/update` chunks into transcript entries (message, thought, tool call, plan, permission, error) and pushes each changed entry to the UI. Rust owns the transcript; React only renders it.
- **Chat history** — transcripts are saved to `~/.yaah/sessions/<id>.json` (on creation, after each turn, on UI renders) and restored at startup. A restored chat reattaches on its next message with ACP `session/load`; the agent's replay of history is ignored since yaah already has it.
- **accounts.rs** — an account is a Claude Code config dir. `default` is `~/.claude`; every `~/.claude-<name>` with a `.claude.json` (or a `.yaah-account` marker, for accounts added in the app) is another account, selected by spawning the agent with `CLAUDE_CONFIG_DIR`. `ANTHROPIC_API_KEY` is removed from the agent's environment so it can't override the account's login.
- **login.rs** — logging in from the UI via ACP terminal auth: the client advertises `auth.terminal`, the agent lists methods such as `--cli auth login --claudeai`, and we rerun the agent command with those args under the account's `CLAUDE_CONFIG_DIR`. The browser sign-in finishes on its own; a fallback URL and a paste-code box cover the manual path.
- **Quick chats** — a chat doesn't need a project: ⌘N with nothing selected (or "New quick chat" in ⌘K) starts one in a fresh scratch folder (`~/.yaah/scratch/<id>/`), and "New chat in a folder…" starts one in any folder. They list under **Chats** in the sidebar. A chat can be moved into a project or "turned into a project" (its folder becomes the first repo) without losing history.
- **projects.rs** — a project is a name, a status (planning → ongoing → done → archived) and one or more folders. Chats run in the first folder; the others and the project's context folder (`~/.yaah/projects/<id>/`) go to `session/new` as `additionalDirectories`. Its brief, `project.md`, is embedded in the first prompt of each chat. Registry: `~/.config/yaah/projects.json`.
- **repos.rs** — the "Add repos" picker: lists every git repo (name, origin, branch; worktrees included) under the workspace folder(s) saved in `~/.config/yaah/settings.json` (default: the first of `~/Documents/workspace`, `~/workspace`, `~/code`, … that exists), and clones `owner/repo` (via `gh` when installed) or any git URL into it.
- **ui_library.rs / ui_mcp.rs / ui_files.rs** — agent-built UI. Screenshots referenced by path in an `image` `src` are inlined as data URLs (a path anywhere else, such as a form default, stays a path); `browser` previews of local pages are served from the UI server under `/preview/<random id>/` (a separate origin from the app, so the page has its own storage but can't reach yaah). A preview serves only static web files (HTML, CSS, JS, JSON, images, fonts, wasm, source maps) from the page's folder, refuses a page sitting directly in a shared temp folder, and sends a Content-Security-Policy that lets the page load from the web but only talk to its own folder (no fetch elsewhere, form posts or popups). A component is data: a tree of the base primitives in `src/ui-primitives.json` (and other library components) with `{{bindings}}` to its props, a JSON Schema and examples. The library lives in `~/.yaah/components/<name>/` with version history, behind a `ComponentSource` trait so a shared, git-backed source can be added later. Each chat gets an HTTP MCP server URL (`127.0.0.1`, per-chat secret token) with `ui_catalog`, `ui_get_component`, `ui_render`, `ui_ask`, `ui_get_values`, `ui_set_values`, `ui_save_component` and `source_read`; Claude Code is told to allow the `ui_*` tools without prompts (each by name), while `source_read` asks like any other tool. **ACP vs MCP:** ACP is how yaah runs the agent (sessions, prompts, streaming, permissions); the MCP server is how the agent calls back into yaah. yaah hands it to the agent in `session/new` (`mcpServers`), and its calls still show in the chat as ACP tool calls. Rendered UI is a `ui` transcript entry (`src/components/ui-render.tsx`) drawn with the same shadcn components as the rest of the app — no agent code runs. The **Component library** page browses it.

- **The yaah pack** (`src-tauri/components/*.json`, `ui_library::Bundled`) — components that ship with the app, listed first in the library as "Provided by yaah": `test-report`, `file-tree`, `json-view`, `file-view`, `word-count`, `git-graph`, `git-status`, `diff-stat`, `system-monitor`, `docker-dashboard`, `container-logs`, `db-explorer`, `db-query`, `sql-editor`, `pr-view`, `pr-list`. They are read-only and their names are reserved: agents use and compose them, and saving under one of their names is refused. To launch a new one, drop a JSON file in `src-tauri/components/` (`build.rs` embeds every file). `every_bundled_component_is_valid` checks it like an agent save and renders every example.
- **Command output views** (`src/components/ui-blocks/cli/`) — primitives that take output as printed: `tests` (cargo, pytest -v, go test -v, jest/vitest, node --test spec and TAP, mix test, rspec; green/red with failures first), `filetree` (`tree` or a path list), `json` (jq/curl, several documents in a row), `textfile` (cat/head/sed; Markdown, CSV and JSON get their own views), `wordcount` (wc), `gitgraph` (`git log --graph`, lanes drawn as SVG), `gitstatus` (porcelain or long form) and `diffstat` (--stat). Parsers are pure functions in `parse.ts`, checked against real output from each tool.
- **Pointing with `find`** — `table`, `tests`, `filetree`, `json` and `textfile` take a `find`: the agent fills the search box to show where something is. The tree opens down to the matches, JSON opens to a key, value or path (`customer.email`), and the file view marks every match with ↑↓ to step between them. Re-rendering with the same id and a new `find` moves the highlight.
- **SQL editor** (`sql` primitive, `src/components/ui-blocks/sql.tsx`) — CodeMirror with PostgreSQL highlighting and completion from the connection's real schema, ⌘↵ to run through the read-only `postgres.query` source, results in the data table, a history of runs, and "Send to chat" to draft the query and its outcome into the composer. The agent starts it with a suggested query and rewrites it by rendering again with the same id.
- **Themes** (Settings → General, `src/lib/theme-map.ts`, `src/lib/theme.ts`) — Appearance is System, Light or Dark, in yaah's own colours by default. On top of that, pick one theme for light mode and one for dark mode from any VS Code colour theme:
  - the 65 that ship with Shiki (`@shikijs/themes`);
  - any theme's `.json` (JSONC is fine) dropped into `~/.config/yaah/themes/`. Only file names cross the API, never paths.

  Each colour comes from the first theme key that's legible, otherwise the theme's own hue is corrected until it is: text 4.5:1, secondary text 3:1, accent 3:1, button text 4.5:1, sidebar text included. Chart colours stay the validated colour-blind-safe palette. Hovering a theme in the picker previews the whole app.

  `pnpm themes` (`scripts/build-themes.ts`) rebuilds `src/lib/themes.json` from `@shikijs/themes` and fails if any theme comes out unreadable. It's a Node script because it runs the app's own TypeScript mapping over an npm package; run it after upgrading `@shikijs/themes`.

- **Integrations** (`integrations.rs`, Settings → Integrations, ⌘K → "Integrations…") — GitHub and Linear, over OAuth with public client IDs and no client secret. GitHub uses the Device Flow: one click copies a code and opens github.com, and yaah polls until you approve. GitHub's web flow needs a client secret, so it can't be used from a desktop app. Linear uses PKCE: one click opens Linear, which calls back to yaah's loopback server on `127.0.0.1:43117`. Tokens live in `~/.config/yaah/integrations.json` (0600), stamped with `expires_at` and refreshed two minutes early (Linear's last 24h). Fallbacks: a personal API key (checked before saving), `GITHUB_TOKEN`/`LINEAR_API_KEY`. `YAAH_GITHUB_CLIENT_ID`/`YAAH_LINEAR_CLIENT_ID` point at other OAuth apps. No `gh` CLI is involved. `cargo run --example source_read -- --integrations` shows what's connected, never the tokens.
- **Live sources** (`sources.rs`) — data the app reads itself: `system` (sysinfo), `docker.containers`/`docker.stats`/`docker.logs` (the docker CLI) and `github.pr`/`github.pr.diff`/`github.prs` (GitHub's GraphQL and REST APIs with the account connected in Settings → Integrations, no gh CLI; checks are normalised to pass/fail/pending with failures first), `linear.issue`/`linear.issues`/`linear.board`/`linear.cycle` (Linear's GraphQL API) and `postgres.schema`/`postgres.query`. Queries run in a READ ONLY transaction with a 15s timeout and a row limit, and only as a read-only role: a superuser, or a role holding `pg_read_server_files`, `pg_write_server_files`, `pg_execute_server_program` or `pg_signal_backend` (directly or through membership), is refused when the connection is added and before any query runs, since a read-only transaction doesn't stop those reading server files or running programs. Create one with `CREATE ROLE yaah_ro LOGIN PASSWORD '…'; GRANT pg_read_all_data TO yaah_ro;` (PostgreSQL 14+). A `live` node feeds its children from a source on an interval, with `history` for charts over time, and keeps refreshing after the turn ends. Database connections are added in ⌘K → "Add database connection…" (tested before saving) and stored in `~/.config/yaah/connections.json` (0600). Agents see only their names; credentials never reach them. `cargo run --example source_read -- '{"kind":"system"}'` reads one from the command line.
- **Forms you fill in together** — a form's unsent values are a draft that Rust keeps in the transcript entry. The person's edits go there (debounced), and the agent reads them with `ui_get_values` and writes them with `ui_set_values`. Fields the agent set are marked "agent" and flash when it changes them. The last write to a field wins, and sending locks the form. Re-rendering the same form keeps the draft.

## UI in a browser

With `pnpm dev` running, open http://localhost:1420 in a normal browser: `src/dev/browser-mock.ts` answers the Rust commands with fixtures, so screens can be checked without the native app. It is only loaded in dev and outside Tauri.

## Checks

The toolchain is pinned in `mise.toml` (`mise install`). Before sending a change:

```sh
pnpm check                                   # tsc, ESLint, Prettier, Vitest
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings    # pedantic lints; unsafe code is forbidden
cargo test --lib --tests                     # unit, ACP end-to-end, Postgres and Docker tests
cargo deny check                             # advisories, licences, sources
```

- `pnpm format` and `cargo fmt` fix formatting.
- `pnpm coverage` and `cargo llvm-cov --lib --tests --summary-only` report coverage.
- Tests prefer real things to mocks:
  - `tests/acp_e2e` runs a scripted ACP agent as a real stdio process;
  - the Postgres and Docker tests use the local daemon and skip when it's absent;
  - OAuth, the MCP client and yaah's UI server are tested against real local HTTP servers;
  - the frontend tests render the real `App` against the browser mock.

## Headless check

```sh
cd src-tauri
cargo run --example acp_smoke -- <account-id> "Reply with exactly: pong"
```

Live tests against a real account (opt-in; they use a little of its quota):

```sh
YAAH_LIVE_ACCOUNT=default cargo test --lib live_ -- --ignored --nocapture
```

`live_chat_with_permission` drives a chat through a permission prompt; `live_ui_builds_and_renders_a_component` checks the agent finds the UI tools, saves a component and renders it. `YAAH_RECORD=<file>` saves the events for UI replays (see `src/dev/fixtures/`).

## Known gaps (PoC)

- The client advertises no `fs` or `terminal` capabilities; the agent uses its own.
- Slash commands, modes and model selection that the agent advertises are not shown.
- Images and attachments in prompts are not supported.

## Frontend notes

- **Diffs** (`src/components/diff/`) — one model (files → hunks → numbered lines) from `git diff` text or old/new text (LCS line diff), and one viewer used by tool calls and agent-built UI. It adapts to size: ≤60 changed lines inline, ≤600 folded to a 24-line preview per file, larger as a ranked summary card. Any of them opens a full-screen review (`j`/`k` files, `n`/`p` hunks, `/` filter). Inside a chat, "Ask about this" on a hunk drafts `About @file lines a–b:` into the composer.
- **Library-backed components** (`src/components/ui-blocks/`) — `chart` (Recharts via shadcn chart, palette validated with the dataviz checker: CVD ΔE ≥ 8.4, legend + table view always), `map` (Leaflet + OpenStreetMap), `table` (TanStack Table: sort, filter past 8 rows, pages past 25) and the live `timer`. Each loads on first use. Every primitive declares its libraries in `ui-primitives.json` (`uses`); a library component's libraries are derived through its tree (and nested components) and shown in `ui_catalog` and on the Component library page. `ui_render` takes an `id`: rendering the same id again updates that UI in place (live status panels).
- **Collaboration** — inputs (`form` with `textfield`, `choice`, `select`, `slider`, `rank`, `toggle`) keep their values in the app while the user edits. The agent's `ui_ask` tool shows a form and waits (up to an hour) for the answer, which returns as JSON in the same turn; Stop cancels it. A form shown with `ui_render` sends its answer as the next message. Answered forms lock and keep the answer in the transcript. `button.draft` puts text in the composer for the user to edit.
- **Diagrams** — `diagram` renders Mermaid (lazy), themed with the app, `securityLevel: strict`.
- **Persona exploration** — `docs/agent-ui-personas.md`: what eight kinds of users hit, what was fixed, and ranked proposals.
- **Chat context** (`src/components/chat-context.tsx`) — components rendered inside a chat can read its session/cwd and draft into its composer (`draftIntoComposer`).
- **Keyboard** — ⌘K palette, ⌘N new chat, ⌘⇧N new project, ⌘L composer, ⌘. stop, ⌘[ / ⌘] and ⌘1–9 switch chats, ⌘/ all shortcuts (Ctrl on Linux). The composer completes `/` commands (from the agent) and `@` files (searched in Rust).
