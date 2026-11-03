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
- **projects.rs** — a project is a name, a status (planning → ongoing → done → archived) and one or more folders. Chats run in the first folder; the others and the project's context folder (`~/.yaah/projects/<id>/`) go to `session/new` as `additionalDirectories`. Its brief, `project.md`, is embedded in the first prompt of each chat. A project started from a tracker item keeps a `link` to it (service, id, url, title, `linkedAt`/`syncedAt` in seconds). Registry: `~/.config/yaah/projects.json`.
- **Projects from tracker items** (`work_items.rs`) — start a project from a GitHub issue, a Linear issue, a Linear project or a GitLab issue, picked from your queue or pasted (a URL, `owner/repo#12`, `group/sub/project#7`, `ENG-142`). Read-only: yaah never writes to the tracker and creates no branches.
  - `work_queue` reads your open items from every connected service in parallel (15 s each): GitHub issues assigned to or created by you (pull requests left out; assigned wins when both), Linear issues likewise, Linear projects you lead or are a member of, GitLab issues. One service failing or slow never hides the others; it comes back as an error with a kind (`auth`, `forbidden`, `not_found`, `rate_limited`, `other`). Items a project already follows carry its `projectId`.
  - `resolve_work_item` reads a pasted URL or id. A bare `owner/repo#12` is GitHub's unless only GitLab is connected; a GitLab URL must be on the connected instance.
  - `start_project_from_item` returns the project already following the item if there is one (ids compare without case) and creates nothing. Otherwise it creates the project (`ENG-142 Title`, `#12 Title`, a Linear project's name; 80 characters at most), sets its status from the item's (done/closed/completed/merged → done; canceled/archived/won't fix/not planned → archived; backlog/todo/unstarted/triage/open/planned → planning; anything else → ongoing), writes the item into the brief, adds every local clone whose `origin` is the issue's repo (https, ssh or scp-style, with or without `.git`; worktrees only when there's no main checkout), opens a chat with the default agent (or the one picked) and returns the composer's draft (`Work on ENG-142: Title`, `Plan the work for <project>`). It never sends a prompt. If the chat can't start, the project stays and `chatError` says why.
  - The brief block sits between `<!-- yaah:source:start -->` and `<!-- yaah:source:end -->` at the top of `project.md`: title, source, status, assignee, labels, the description and the latest 10 comments (oldest of them first, each cut to 2000 characters); for a Linear project, its state, progress, lead and teams, then its issues. `refresh_project_link` rewrites only that block (and `link.title`/`syncedAt`), never the project's name or status, so what you write around it stays; `unlink_project` drops the link and the block. The item's own text can't close the block early (the markers in it are defused). Each emits `projects-changed`.
- **repos.rs** — the "Add repos" picker: lists every git repo (name, origin, branch; worktrees included) under the workspace folder(s) saved in `~/.config/yaah/settings.json` (default: the first of `~/Documents/workspace`, `~/workspace`, `~/code`, … that exists), and clones `owner/repo` (via `gh` when installed) or any git URL into it.
- **ui_library.rs / ui_mcp.rs / ui_files.rs** — agent-built UI. Screenshots referenced by path in an `image` `src` are inlined as data URLs (a path anywhere else, such as a form default, stays a path); `browser` previews of local pages are served from the UI server under `/preview/<random id>/` (a separate origin from the app, so the page has its own storage but can't reach yaah). A preview serves only static web files (HTML, CSS, JS, JSON, images, fonts, wasm, source maps) from the page's folder, refuses a page sitting directly in a shared temp folder, and sends a Content-Security-Policy that lets the page load from the web but only talk to its own folder (no fetch elsewhere, form posts or popups). A component is data: a tree of the base primitives in `src/ui-primitives.json` (and other library components) with `{{bindings}}` to its props, a JSON Schema and examples. The library lives in `~/.yaah/components/<name>/` with version history, behind a `ComponentSource` trait; installed component libraries (`ui_libraries.rs`, see [Component libraries](#component-libraries)) sit beside it. Each chat gets an HTTP MCP server URL (`127.0.0.1`, per-chat secret token) with `ui_catalog`, `ui_guide`, `ui_get_component`, `ui_render`, `ui_ask`, `ui_get_values`, `ui_set_values`, `ui_save_component` and `source_read` (and yaah's skills as MCP resources and prompts, see [What agents are told](#what-agents-are-told)); Claude Code is told to allow the `ui_*` tools without prompts (each by name), while `source_read` asks like any other tool. **ACP vs MCP:** ACP is how yaah runs the agent (sessions, prompts, streaming, permissions); the MCP server is how the agent calls back into yaah. yaah hands it to the agent in `session/new` (`mcpServers`), and its calls still show in the chat as ACP tool calls. Rendered UI is a `ui` transcript entry (`src/components/ui-render.tsx`) drawn with the same shadcn components as the rest of the app — no agent code runs. The **Component library** page browses it.

- **The yaah pack** (`src-tauri/components/*.json`, `ui_library::Bundled`) — components that ship with the app, listed first in the library as "Provided by yaah": `test-report`, `file-tree`, `json-view`, `file-view`, `word-count`, `git-graph`, `git-status`, `diff-stat`, `system-monitor`, `docker-dashboard`, `container-logs`, `db-explorer`, `db-query`, `sql-editor`, `pr-view`, `pr-list`, `github-issue`, `gitlab-issue`, `linear-issue`, `linear-issues`, `linear-board`, `linear-cycle`, `linear-project`. They are read-only and their names are reserved: agents use and compose them, and saving under one of their names is refused. To launch a new one, drop a JSON file in `src-tauri/components/` (`build.rs` embeds every file). `every_bundled_component_is_valid` checks it like an agent save and renders every example.
- **Command output views** (`src/components/ui-blocks/cli/`) — primitives that take output as printed: `tests` (cargo, pytest -v, go test -v, jest/vitest, node --test spec and TAP, mix test, rspec; green/red with failures first), `filetree` (`tree` or a path list), `json` (jq/curl, several documents in a row), `textfile` (cat/head/sed; Markdown, CSV and JSON get their own views), `wordcount` (wc), `gitgraph` (`git log --graph`, lanes drawn as SVG), `gitstatus` (porcelain or long form) and `diffstat` (--stat). Parsers are pure functions in `parse.ts`, checked against real output from each tool.
- **Pointing with `find`** — `table`, `tests`, `filetree`, `json` and `textfile` take a `find`: the agent fills the search box to show where something is. The tree opens down to the matches, JSON opens to a key, value or path (`customer.email`), and the file view marks every match with ↑↓ to step between them. Re-rendering with the same id and a new `find` moves the highlight.
- **SQL editor** (`sql` primitive, `src/components/ui-blocks/sql.tsx`) — CodeMirror with PostgreSQL highlighting and completion from the connection's real schema, ⌘↵ to run through the read-only `postgres.query` source, results in the data table, a history of runs, and "Send to chat" to draft the query and its outcome into the composer. The agent starts it with a suggested query and rewrites it by rendering again with the same id.
- **Themes** (Settings → General, `src/lib/theme-map.ts`, `src/lib/theme.ts`) — Appearance is System, Light or Dark, in yaah's own colours by default. On top of that, pick one theme for light mode and one for dark mode from any VS Code colour theme:
  - the 65 that ship with Shiki (`@shikijs/themes`);
  - any theme's `.json` (JSONC is fine) dropped into `~/.config/yaah/themes/`. Only file names cross the API, never paths.

  Each colour comes from the first theme key that's legible, otherwise the theme's own hue is corrected until it is: text 4.5:1, secondary text 3:1, accent 3:1, button text 4.5:1, sidebar text included. Chart colours stay the validated colour-blind-safe palette. Hovering a theme in the picker previews the whole app.

  `pnpm themes` (`scripts/build-themes.ts`) rebuilds `src/lib/themes.json` from `@shikijs/themes` and fails if any theme comes out unreadable. It's a Node script because it runs the app's own TypeScript mapping over an npm package; run it after upgrading `@shikijs/themes`.

- **Integrations** (`integrations.rs`, Settings → Integrations, ⌘K → "Integrations…") — GitHub, Linear and GitLab, over OAuth with public client IDs and no client secret. GitHub uses the Device Flow: one click copies a code and opens github.com, and yaah polls until you approve. GitHub's web flow needs a client secret, so it can't be used from a desktop app. Linear uses PKCE: one click opens Linear, which calls back to yaah's loopback server on `127.0.0.1:43117`. GitLab uses PKCE too (scopes `read_api read_user`), but no OAuth app ships for it: set `YAAH_GITLAB_CLIENT_ID` to the application ID of an OAuth app you register (redirect URI `http://127.0.0.1:43117/oauth/callback/gitlab`, not confidential, scopes `read_api read_user`); without it Settings offers only a personal access token (`read_api`), and its `flow` is `key`. GitLab takes a base URL for a self-managed instance (`baseUrl` on connect and on saving a key, https only, default `https://gitlab.com`), remembered with the credential. Tokens live in `~/.config/yaah/integrations.json` (0600), stamped with `expires_at` and refreshed two minutes early (Linear's last 24h). Fallbacks: a personal API key (checked before saving), `GITHUB_TOKEN`/`LINEAR_API_KEY`/`GITLAB_TOKEN` (gitlab.com). `YAAH_GITHUB_CLIENT_ID`/`YAAH_LINEAR_CLIENT_ID` point at other OAuth apps. No `gh` CLI is involved. `cargo run --example source_read -- --integrations` shows what's connected, never the tokens.
- **Live sources** (`sources.rs`) — data the app reads itself: `system` (sysinfo), `docker.containers`/`docker.stats`/`docker.logs` (the docker CLI) and `github.pr`/`github.pr.diff`/`github.prs`/`github.issue`/`github.issues` (GitHub's GraphQL and REST APIs with the account connected in Settings → Integrations, no gh CLI; checks are normalised to pass/fail/pending with failures first), `gitlab.issue`/`gitlab.issues` (GitLab's REST API on the connected instance; system notes left out), `linear.issue`/`linear.issues`/`linear.project`/`linear.board`/`linear.cycle` (Linear's GraphQL API) and `postgres.schema`/`postgres.query`. Queries run in a READ ONLY transaction with a 15s timeout and a row limit, and only as a read-only role: a superuser, or a role holding `pg_read_server_files`, `pg_write_server_files`, `pg_execute_server_program` or `pg_signal_backend` (directly or through membership), is refused when the connection is added and before any query runs, since a read-only transaction doesn't stop those reading server files or running programs. Create one with `CREATE ROLE yaah_ro LOGIN PASSWORD '…'; GRANT pg_read_all_data TO yaah_ro;` (PostgreSQL 14+). A `live` node feeds its children from a source on an interval, with `history` for charts over time, and keeps refreshing after the turn ends. Database connections are added in ⌘K → "Add database connection…" (tested before saving) and stored in `~/.config/yaah/connections.json` (0600). Agents see only their names; credentials never reach them. `cargo run --example source_read -- '{"kind":"system"}'` reads one from the command line.
- **Forms you fill in together** — a form's unsent values are a draft that Rust keeps in the transcript entry. The person's edits go there (debounced), and the agent reads them with `ui_get_values` and writes them with `ui_set_values`. Fields the agent set are marked "agent" and flash when it changes them. The last write to a field wins, and sending locks the form. Re-rendering the same form keeps the draft.

## What agents are told

Agents can answer with UI, but only if they know it: MCP tools may be deferred, and an agent's habit is to `open` a file or write a standalone HTML page. So yaah teaches every chat's agent, with text it owns in `src-tauri/agent-guide/` (Markdown, embedded at build time; `agent_guide.rs`):

- **The guide** (`guide.md`, about 350 tokens): you're inside yaah; answer with UI whenever you'd show, compare, review, present, play, chart, tabulate, ask or build something interactive; never `open` or write HTML just to show something (a page you built goes in `browser`); load deferred `yaah-ui` tools with ToolSearch; `ui_catalog` first; components, `library/name` and `ui_save_component`; `source_read` and `live`. It ends with the components available now (yaah's, yours, enabled libraries'; the first 40 names, then "+N more").
- **Two skills** in the open Agent Skills format (`SKILL.md` with `name`/`description` frontmatter): `yaah-ui` (when and how, patterns, fixing validation errors, a primitive index generated from `src/ui-primitives.json`) and `yaah-components` (saving reusable components: props schema, examples, versions, libraries). yaah writes them to `~/.yaah/agent-skills/<name>/SKILL.md` at startup and when the library changes, only when their text changed. Nothing is ever written into an agent's own config (`~/.claude*`, `~/.codex`, …).

How it reaches an agent, generic routes first (only agents that get the UI server; `agent_guide::plan`):

- **The `yaah-ui` MCP server**: its instructions, the `ui_guide` tool, and the skills as resources (`yaah://skills/yaah-ui`) and prompts. Every agent with the UI tools, even with the setting off.
- **ACP `systemPrompt`** (`append`) on `session/new` and `session/load`, for agents advertising `sessionCapabilities.systemPrompt` (claude-agent-acp 0.99, codex-acp 2.5).
- **The chat's first prompt**, once, shown as an attachment, for everyone else (Gemini CLI 0.63, …).
- **Claude Code extras**: `_meta.claudeCode.options.plugins` → `~/.yaah/agent-plugin` (the same skills as a plugin), and `_meta.systemPrompt.append` only when the adapter has no ACP `systemPrompt`.

Codex reads skills only from `<additional dir>/.agents/skills`, which would make yaah's folder a trusted, writable root for it, and Gemini's `session/new` takes no skills option, so both get the generic routes; `agent_guide::extras` is where an agent's own option goes when it has one. Settings → Chat → "Teach agents about yaah's UI" (on by default, `teachAgents` in `settings.json`) turns off everything but the MCP server's own; "Show what agents are told" shows the guide, the skills and each agent's routes.

## Component libraries

A component library is a set of components someone else made (a person, a team, a company) that yaah users install beside yaah's own and their own collection. Install, update, turn off and remove them on the Component library page; share your own collection from there too (it writes a library folder ready to push as a git repo).

**Components are data, not code.** A library can only render UI drawn with yaah's primitives, and it can only read the live sources it names: every `live` node in a library must write its source `kind` out (`{ "kind": "github.pr", … }`, never `{{…}}` from props), so the kinds it reads (`github`, `postgres`, `docker`…) are shown before you install it, as `reads`. The data still comes through the user's own connections, read-only as everywhere else, and the library never sees a credential. Primitives that show web content (an `image` URL, a `browser` page) load it like any page would.

**Layout.** A git repo (or a local folder) with:

```
yaah-library.json        the manifest (required, ≤ 64 KB)
components/<name>.json   one component per file, the same format as src-tauri/components/*.json
README.md                optional
```

```json
{
  "name": "acme",
  "title": "Acme components",
  "description": "What's in it",
  "publisher": "Acme Inc.",
  "homepage": "https://acme.dev/yaah",
  "version": "1.2.0"
}
```

`name` is the library's id and namespace: kebab-case, 2–32 characters; `yaah` and `local` are reserved. `title` and `description` are expected (they're reported when missing); `homepage` must be an http(s) URL. Each component's `name` field is its short name and must equal its file name.

**Qualified names.** Inside the app a library's component is `<library>/<name>` everywhere: the catalog, `$component` references, `ui_render`'s `component`, the UI. Inside a library:

- refer to its own components qualified (`acme/card`, never `card`);
- an unqualified name may only be one of yaah's own components or a primitive, never the user's local ones (they differ from user to user);
- another library's components (`other/x`) are allowed, and that library is listed as `needs: ["other"]`; it has to be installed for those to render.

Unqualified names in agents' trees and the user's own components keep resolving as before: yaah's own first, then local.

**Validation and limits.** At most 500 components, each file at most 256 KB, regular files only: symlinks are skipped and reported, and paths can't leave the library's folder. Every component is checked like an agent's save (props schema, a valid tree, examples that fit, at most 3000 nodes once nested components are filled in, no cycles). A component that fails, or uses one of its library's components that failed, is reported with why and not loaded; the rest load. A manifest that's missing, invalid or uses a reserved name stops the install.

**Installing from git.** Paste an `https://…`, `ssh://…` or `user@host:path` URL. yaah shallow-clones it with `git` (never a shell) into a staging folder, validates it and shows a preview; nothing is installed until you confirm. Only https and ssh are allowed (no `file://`, no `ext::`, nothing starting with `-`), hooks and submodules are off, symlinks are checked out as plain files, git never prompts, and a fetch is stopped after 120 s. Checkouts live in `~/.yaah/libraries/<id>/`, records in `~/.config/yaah/libraries.json`.

**Private repos.** For `https://github.com/…`, connect GitHub in Settings → Integrations (or set `GITHUB_TOKEN`): yaah passes the token to git through its environment as an `http.extraheader`, never on the command line. Anything else uses your own git credentials: an SSH key (with `ssh://` or `git@host:path` URLs) or a credential helper for https.

**Pinning.** Give a `ref` (a tag such as `v1.2.0`, or a branch) to install that instead of the default branch. Tags make releases: publish a new version by pushing a new tag, and users who pinned the old one stay on it until they change the ref.

**Updating.** Update fetches the same URL and ref again into staging and swaps it in only if it still validates and still has the same `name`; otherwise the installed version stays. The result lists the commit before and after and the components added, removed or changed. A folder library is read in place and reloaded when its files change, so while authoring you see edits without reinstalling.

**Using one.** Installed libraries' components show in `ui_catalog` (with their `source` and library title) for agents, and in the Component library page. They're read-only: copying one into your collection (from the Component library page) makes an editable local copy (references to its own library stay qualified), and an agent's `ui_save_component` with a qualified name is refused with a note to copy it first. Turning a library off hides its components without uninstalling it.

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
  - GitHub, GitLab and Linear reads (the queue, items, live sources) go to a local stand-in serving answers shaped like the real APIs, through a base URL only tests set, with real git repos for matching clones; no test calls a real tracker;
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
