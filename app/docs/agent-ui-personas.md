# Agent-built UI: persona exploration (2026-11-01)

Four sub-agents each took two personas, read the UI system, and rendered their
ideas through the real renderer (`#playground`) to find where it breaks.
Screenshots of every finding were kept with the session's scratch files.

| Agent | Personas                                 |
| ----- | ---------------------------------------- |
| A     | Data analyst · startup founder/ops       |
| B     | SRE on call · QA lead                    |
| C     | Product manager · product designer       |
| D     | Learner/teacher · customer support agent |

## What already works well

- Pre-sliced data in `tabs` + `each` gives instant client-side drill-down from a small payload (A).
- A 5,000-row table stays responsive (filter ≈100 ms/keystroke, sort ≈45 ms) (A).
- `timer` covers incident age, status-update deadlines, per-job elapsed time, SLA countdowns and confirmation expiry, all with no agent turn (B, D).
- UI state (selected tab, sort, filter, scroll, chart/table toggle) survives an in-place re-render of the same shape (B, D).
- Two-step destructive confirmations, decision memos, kanban boards and quizzes are expressible with today's primitives (B, C, D).
- Dark mode is clean for every built-in primitive. Bindings can't be injected through data (`{{secret}}` in customer text stays literal) (D).

## Fixed straight away

| Finding                                                                                 | Fix                                                                                                      |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Markdown links rendered as plain `<a href>`, likely navigating the app webview (D)      | One safe markdown renderer for chat and UI: http(s) opens in the system browser, other schemes are inert |
| Markdown images loaded remote URLs (tracking pixels) (D)                                | Remote images are a click-to-load placeholder; `data:` images still show                                 |
| Negative stacks drawn upward (churn looked positive) (A)                                | `stackOffset="sign"` when any value is negative                                                          |
| Legend order didn't match series order (A)                                              | Legend keeps series order                                                                                |
| "Other" folded by position, and summed on line charts (A)                               | Fold the smallest series; average (not sum) on non-stacked charts                                        |
| Y axis clipped large numbers; tooltip dropped the unit (A, B)                           | Compact currency/number format (`$4.5M`), axis width fits labels, tooltip shows the formatted value      |
| Expanded sections jumped to another item when a list reordered (B)                      | `each` takes `key` (an item field)                                                                       |
| `collapsible.open` ignored after mount (B, D)                                           | Follows the prop                                                                                         |
| Table jumped to page 1 on every live update; hidden filter stranded "No rows match" (B) | Page kept; filter box stays while a filter is active                                                     |
| `grid.columns` was a hint (7 columns at 768px) (B)                                      | Exactly that many columns                                                                                |
| Small screenshots stretched to full width (C)                                           | Natural size, capped by the column; tall images scroll                                                   |
| Timer said nothing useful after the deadline (D)                                        | "overdue 12m 00s", counting, in red                                                                      |
| A button with a non-web `href` was enabled but did nothing (A, D)                       | Disabled                                                                                                 |
| Clipboard blocked inside `browser` previews (D)                                         | `allow="clipboard-write"`                                                                                |

## Proposals, ranked by how many personas they unblock

### Capabilities

1. **Inputs and client-side state** — every persona. No input means multi-select, ranking, sliders, free text, drafting a reply and committing a quiz answer are each an agent turn per click, or impossible. Proposal: input primitives inside a `form`; values stay in the app; submit returns structured data; an agent tool that asks and _waits_ for the answer in the same turn; answered forms lock. Cheapest step: `button.draft` (uses the existing `draftIntoComposer`). **Built:** `form` with `textfield`, `choice` (quiz mode with `correct`), `select`, `slider`, `rank`, `toggle`; the `ui_ask` tool (the agent waits for the answer and gets JSON in the same turn, tested live with Claude); answered forms lock; `button.draft`.
2. **Data by reference, not through output tokens** — analyst, SRE, QA. 5,000 rows is 2.4 MB (≈700k tokens) of `ui_render` arguments, re-sent on every update. Proposal: `rows: {"$file": "/abs/data.csv"}` (and later `$query`) resolved by Rust like images; append-only updates for logs.
3. **Live data without an agent turn** — SRE, QA, founder. Dashboards freeze when the turn ends. Proposal: app-side sources bound to props (tail a file, run a command on an interval, poll a URL, or subscribe to an MCP resource), scoped to the chat's folders.
4. **Interaction model** — SRE, QA, PM.
   - Prompt buttons are disabled while the agent is busy, which is exactly when a live panel matters. Queue them instead.
   - Answered or superseded UI should lock.
   - In-place updates happen silently at the panel's original position. Add an `attention` level that marks the chat unread, plus an OS notification for critical updates.
5. **Export and share** — PM, analyst, support. Nothing leaves the app except props JSON. Proposal: per-entry export (Markdown, static HTML, PNG, CSV), and copy actions on `code`, `table` and `text`.
6. **Privacy** — support.
   - A `sensitive` flag that masks a value, keeps it out of "Copy props JSON", and keeps it out of saved transcripts.
   - Give each chat's `browser` previews their own stable origin. Today it's a random port shared by every chat.

### New primitives

| Primitive                           | For                           | Notes                                                                                                                                |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `log`                               | SRE, QA                       | `maxHeight`, follow-tail, level colours, filter, append updates (5k lines was 80,000 px tall)                                        |
| Typed table cells + column `format` | analyst, founder, QA, support | `{value, display, tone, href}`, currency/percent/compact/date; sorts on value, shows display; `heat` for cohort grids                |
| More chart kinds                    | analyst, founder, PM          | scatter (numeric x), histogram from raw values, pie/donut, funnel with stage %, timeline/gantt; period compare with Δ in the tooltip |
| `stat.sentiment` / badge tones      | founder, SRE                  | "burn up" shouldn't look like "MRR up"                                                                                               |
| `code` highlighting                 | learner                       | lazy Shiki; `lineNumbers`, `highlight: [4,5,6]`                                                                                      |
| `diagram`                           | learner                       | **Built:** Mermaid (sequence, flowchart/network, ER, state), themed for light and dark, strict security                              |
| `compare`                           | designer                      | before/after slider, onion skin, difference                                                                                          |
| `image` lightbox + `annotations`    | designer                      | pins/boxes in image-relative %; `srcDark` / background                                                                               |
| `browser.viewport`                  | designer                      | render at 1280 and scale to fit (today every frame is ≤768px)                                                                        |
| `board`                             | PM                            | kanban lanes; a drop sends a templated prompt                                                                                        |
| `steps`, `checklist`                | learner, SRE                  | client-side progress, reported with the next answer                                                                                  |
| `status-grid`                       | QA                            | one dot per job for 60+ parallel jobs                                                                                                |
| `swatch`, `type-specimen`           | designer                      | design tokens without generated SVG                                                                                                  |

## Ideas from Filipe (2026-11-01)

Most of these need data the app reads itself rather than data the agent relays
through its output, so they share one connector layer (proposal 2 and 3 above):
Rust-side sources, scoped and permissioned per chat or project, that UI props
bind to and that the agent can also query.

| Idea                                          | Source                                                              | First components                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| CPU / RAM / disk stats, attachable to Docker  | `sysinfo` locally; Docker stats via the Docker socket               | live `stat` + area `chart` bound to a polled source                                           |
| Docker components                             | Docker socket or `docker` CLI: containers, images, logs, stats      | container table with status badges; `log` tail per container; start/stop as confirmed actions |
| Diagrams: network and service maps, sequences | none (pure renderer)                                                | `diagram` (built)                                                                             |
| Database connectors                           | read-only connections (Postgres first; credentials stay in the app) | schema browser; query → `table` with `$query` rows; chart from a query                        |
| Markdown viewer / editor                      | a file in the chat's folders (`$file`)                              | `markdown` with an edit mode (built on `textfield`), save back with confirmation              |
| GitHub PR viewer                              | GitHub API with the token from Settings → Integrations              | PR header + checks + `patch` diff + review threads; approve/comment as confirmed actions      |
| Linear ticket / project viewer                | Linear API (OAuth, as in Phase 2)                                   | ticket card, project board (`board`), cycle burndown `chart`                                  |

**Built (2026-11-02):** the connector layer (`sources.rs` + the `live` primitive) with system, Docker and read-only Postgres sources; connections added in ⌘K. These now ship as yaah components: `system-monitor`, `docker-dashboard`, `container-logs`, `db-explorer`, `db-query`, plus a `sql-editor` (CodeMirror, schema completion, read-only runs) and the GitHub `pr-view` / `pr-list` (gh sources). Still to do: the markdown editor, the Linear viewer, PR approve/comment and Docker start/stop as confirmed actions.

### More ideas (2026-11-01), built

| Idea                                        | Built as                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Test output in green and red                | `tests` primitive + `test-report`: cargo, pytest, go, jest/vitest, node --test (spec, TAP), mix, rspec             |
| `tree` drawn as a tree                      | `filetree` + `file-tree` (also from find / git ls-files)                                                           |
| `jq` with JSON highlighting                 | `json` + `json-view` (several documents in a row become a list)                                                    |
| `cat` as readable text, sized to the output | `textfile` + `file-view`: inline when short; line numbers, search and wrap when long; Markdown, CSV and JSON views |
| `wc` breakdown                              | `wordcount` + `word-count`                                                                                         |
| Git branching and other git output          | `gitgraph` (`git log --graph`), `gitstatus`, `diffstat`                                                            |

Two follow-ups from Filipe, also built:

- **Agents point with search.** `find` on table, tests, tree, JSON and file views fills the search box, so the agent can show where something is.
- **Agents edit inputs too.** A form's draft is shared: `ui_get_values` / `ui_set_values`, with the agent's fields marked.

All of these ship as the **yaah pack**: read-only components in `src-tauri/components/`, released with the app and extended by adding a file.
