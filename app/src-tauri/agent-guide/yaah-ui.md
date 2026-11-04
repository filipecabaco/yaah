---
name: yaah-ui
description: Answer with interface in yaah's chat instead of prose, files or `open`. Tables, charts, diffs, test results, page previews, slides as tabs, forms that ask the user and wait, and live system, Docker, GitHub, Linear and database views. Use it inside yaah whenever you would show, compare, review, present, play, chart, tabulate, ask for structured input or build something interactive.
---

# Building UI in yaah

yaah renders UI inline in the chat from JSON trees you send through its `yaah-ui` MCP server. Nothing you send runs as code: a tree is data, drawn with the app's own components, themed, and kept in the transcript.

## When

Use UI when it is easier to scan than to read: status overviews, tables, comparisons, metrics, charts, diffs, test results, file trees, progress, a page you built, a few choices for the user. Keep prose to a sentence when UI carries the content, and don't repeat what the UI already shows.

**Tracker items: show the live component.** When the user mentions a GitHub PR or issue, a GitLab issue or a Linear issue (often as a `github#…`, `gitlab#…` or `linear#…` reference, which yaah attaches with the component and props to use), render `pr-view`, `github-issue`, `gitlab-issue` or `linear-issue` first, then add only what it doesn't show: your reading, a risk, a next step. Don't retell its title, state, owner or labels in prose.

**After you render, don't narrate it.** The user sees the UI as it arrives, so don't follow it with a message saying what you rendered, where it is, or that an earlier call of yours failed and you fixed it. Write after a render only when you have something the UI doesn't say: a finding, a question, a decision for the user. If there is nothing to add, end the turn.

Never `open` a file or URL, and never write a standalone HTML file just to show something. Render it in the chat:

- a web page you built: `browser` with the absolute path of its `.html` (it is served with its folder's CSS, JS and images);
- a screenshot or image: `image` with its absolute path;
- slides or steps: `tabs` with one `tab` per slide, or an HTML deck in `browser` when it needs animation;
- 3D, canvas or games: a self-contained HTML page in `browser`;
- something no primitive can show (video, audio and PDF today): say so in one sentence and show what you can (details in a `kv`, a `link`), rather than opening another app.

## Getting the tools

The tools, by the name agents that prefix MCP tools by server see (Claude Code), and the bare name other agents see. Call them by the exact name your tool list shows; a bare `ui_catalog` where the list has `mcp__yaah-ui__ui_catalog` is "No such tool".

{{tools}}

`ui_guide` is this guide. If the tools are deferred or loaded on demand, load them first (with ToolSearch, search for "yaah-ui").

## The loop

1. `ui_catalog` once per chat: every primitive with its props, the tree syntax, the live sources, the database connection names, and every component.
2. Pick a component that fits and render it: `ui_render { "component": "test-report", "props": { … } }`. yaah's own components (source `yaah`) are the supported way to show common things: after running `cargo test`, `tree`, `jq`, `cat`, `wc`, `git log --graph`, `git status` or `--stat`, pass the output as printed to `test-report`, `file-tree`, `json-view`, `file-view`, `word-count`, `git-graph`, `git-status` or `diff-stat`.
3. No component fits: pass an ad-hoc `tree`. If the shape will come up again, save it as a component (see the `yaah-components` skill, or `ui_guide { "topic": "components" }`).

A tree is a node: a string (text), or `{ "type", "props"?, "children"? }`. Strings in props can bind the render's props with `{{path}}`; `{ "each": "rows", "as": "row", "key": "id", "children": [...] }` repeats, `{ "if": "path", "children": [...], "else": [...] }` chooses.

```json
{ "type": "card", "props": { "title": "Services" }, "children": [
  { "type": "table", "props": {
    "columns": [{ "key": "name", "label": "Service" }, { "key": "p95", "label": "p95 (ms)", "align": "right" }],
    "rows": [{ "name": "api", "p95": 42 }, { "name": "worker", "p95": 310 }] } }
] }
```

## Patterns

**Render in steps, update in place.** Give `ui_render` an `id`. Rendering again with the same `id` replaces that UI instead of adding a new one: a status panel you update as work progresses, a sub-agent board, a long job's progress. Render early ("running…"), then again when done.

**Ask with a form and wait.** For choices, rankings, numbers or a few short fields, call `ui_ask` with a `form` of inputs (`textfield`, `choice`, `select`, `slider`, `rank`, `toggle`). It waits for the user and returns their answer as JSON in the same turn. Offer options you can act on, sensible defaults, and a free-text field for what you didn't anticipate.

```json
{ "type": "form", "props": { "submitLabel": "Plan it" }, "children": [
  { "type": "choice", "props": { "name": "scope", "label": "Scope", "options": [
    { "value": "fix", "label": "Just the fix" }, { "value": "refactor", "label": "Fix and refactor" }] } },
  { "type": "slider", "props": { "name": "hours", "label": "Time box", "min": 1, "max": 8, "default": 2, "unit": "h" } },
  { "type": "textfield", "props": { "name": "notes", "label": "Anything else?", "multiline": true } }
] }
```

**Fill a form in together.** Render a form with `ui_render` and an `id` (no waiting), fill in what you know with `ui_set_values` (the user sees it marked as yours), and read what they typed with `ui_get_values`. The last change to a field wins; a sent form is locked.

**Buttons.** A `button` with `prompt` sends that text to you as the user's next message; `draft` puts text in their message box to edit first.

**Expand fills the dialog.** The user can expand any UI (Expand button or F) into a large dialog. `textfile`, `filetree`, `json`, `table`, `chart`, `map`, `gitgraph`, `gitstatus`, `diffstat`, `wordcount` and `diffreview`, and components built on them (`file-view`, `container-logs`, `pr-view`, …), then use all the height with no cap; forms and cards stay at their natural size. When your own tree has one main region that should take the space (a long `list`, `code`, `markdown`, a `stack` of rows), put `"grow": true` on that node (beside `type`, not in `props`); mark only one, and toolbars or headers around it keep their size.

**Point with `find`.** `table`, `tests`, `filetree`, `json` and `textfile` take `find`: it fills their search box to show where something is (a file in a tree, a line in a file, a JSON key, some rows, a test). Re-render with the same `id` and a new `find` to point elsewhere.

**Live data.** For data yaah reads itself (`system`, `docker.*`, `git.*`, `github.*`, `linear.*`, `postgres.*`; see `sources` in `ui_catalog`), look first with `source_read`, then wrap the UI in a `live` node with that `source` and `every` (ms) for refreshing. Children bind the latest result as `{{data}}`, and `history: N` keeps samples as `{{history}}` for charts over time. It keeps updating after your turn ends; you never see credentials.

```json
{ "type": "live", "props": { "source": { "kind": "system" }, "every": 2000, "history": 60 }, "children": [
  { "type": "stat", "props": { "label": "CPU", "value": "{{data.cpu}}%" } },
  { "type": "chart", "props": { "kind": "line", "data": "{{history}}", "x": "t", "series": [{ "key": "cpu", "label": "CPU %" }] } }
] }
```

**MDX in Markdown.** Chat text and `markdown` are read as MDX (an `.mdx` docs page) and drawn safely; nothing in it runs, and plain Markdown reads as usual. Frontmatter folds away, `import`/`export` lines and comments are hidden, `{braces}` are text. `Admonition`, `Callout`, `Note`, `Tip`, `Info`, `Warning`, `Caution`, `Danger` (`type`, `title`) draw as an alert; `Tabs` with `TabPanel`, `Tab` or `TabItem` (`label`, `value`, `id`) as tabs; also `details`/`summary`, `Steps`/`Step`, `Cards`/`Card`, `img`/`Image` and simple HTML (`<br>`, `<kbd>`, `<sup>`). Other components show their content in a box labelled with their name; close them (`</Name>` or `/>`) or they show as text. Props are string or number literals only.

**Command output.** Pass short output as printed to the primitive or component made for it (`tests`, `filetree`, `json`, `textfile`, `wordcount`, `gitgraph`, `gitstatus`, `diffstat`). Don't restate it in prose. Anything long is referenced instead (next section).

## Charts

Pick the form from what the reader must do, before anything else:

| The data | Use |
| --- | --- |
| One number, or a few headline numbers | `stat` (a row of them), not a one-bar chart |
| A ratio against a limit | `progress` |
| A trend over time | `chart` `line`; `area` with `stacked` for parts of a total |
| Amounts to compare | `chart` `bar`, `sort: "value"` unless the order means something |
| Two values per item: before → after, poll → result, target → actual | `chart` `dumbbell` |
| A value per country or US state (geography) | `map` `choropleth` |
| A value at a place: revenue by city, load by data centre (geography) | `map` `bubble` |
| Links between places: flights between hubs, traffic between regions (geography) | `map` `connection` |
| Many raw points where density matters: stations, incidents (geography) | `map` `hexbin` |
| Where something is, or which regions are in a state | `map` `outline`; `markers` (the default) only for streets |
| Quantities flowing through stages: CI runs, requests, cost by step | `flow` `sankey` |
| Relationships: who calls whom, what depends on what | `flow` `network` (a layered architecture: `diagram`) |
| More than about 7 classes that all matter | `table` |

No pie or donut: ranked bars compare parts better. No dual axes: two charts, or index both series to 100.

Colours are not yours to set. Series take the theme's chart colours in order, checked for colour-blind safety on its surface; past 5 series the rest fold into "Other". A dumbbell is two shades of one hue unless `scale` says otherwise: `diverging` (with its `midpoint`) colours each dot by its own value, so use it only for signed values with a meaningful middle, such as margins; for before → after of raw values (points, prices) keep the default or `categorical`; `sequential` for magnitude. At most 7 `bins` (a dumbbell's dots carry 5); the legend shows them.

`refs` draws reference lines (`axis: "y"` is a value, `"x"` a category). `labels`: `ends` (default for line, area and dumbbell) labels the last values or the gaps; `none` (default for bar); avoid `all`. `orientation` overrides bar and dumbbell. `sort`: `value`, or `gap` for a dumbbell. A dumbbell takes exactly 2 series, and any chart at most 2,000 rows. There are no format strings or expressions; `unit` is a short suffix: symbols attach (`"k"` → 16k, `"%"`, `"°C"`, `"$"` leads), words get a space (`"ms"` → 42 ms), and a leading space you write is kept (`" pts"`).

Bars and stacks start at 0. Lines and unstacked areas fit their data (with any refs), so a trend from 100 to 118 fills the chart; `zero: true` starts them at 0, `domain: [low, high]` sets the range (widened to fit the data). End labels and ref labels sit outside the plot, nudged apart when close; one that can't fit leaves its series to the legend.

```json
{ "type": "chart", "props": {
  "kind": "dumbbell", "x": "state", "unit": " pts", "sort": "gap",
  "data": [{ "state": "PA", "poll": -0.5, "result": 1.7 }, { "state": "MI", "poll": -0.8, "result": 1.4 }, { "state": "AZ", "poll": 1.2, "result": 5.5 }],
  "series": [{ "key": "poll", "label": "Poll average" }, { "key": "result", "label": "Result" }],
  "refs": [{ "axis": "y", "value": 0, "label": "Tie" }],
  "scale": { "type": "diverging", "midpoint": 0, "bins": 5 } } }
```

## Maps

`map` `kind` picks the form. Region kinds draw bundled geometry (`region`: `world`, `europe`, `us-states`), work offline, follow the theme, label small sets on the map and flip to a table; `markers` (the default) is a street map with tiles, for "where on the streets" only: `lines: [{ points: [[lat, lng] or a marker id, …], label? }]` draws routes, and from 40 markers close ones group into numbered clusters (`cluster: false` turns that off).

- `choropleth`: `data: [{ id, value, detail? }]`, one row per region (`value: null` is "no data", hatched, never the lowest class). Regions without a row are hatched while most have one, else plain land (a few states of 51); `missing: "hatch"` or `"land"` decides, `noDataLabel` names them. Prefer it when regions are comparable in size. The shared `scale` colours it: `sequential` (default, 5 classes) for magnitude, `diverging` with a `midpoint` for signed values such as margins. Values past `domain` sit in the end classes, labelled "< low" and "> high"; without a `domain`, outliers are fenced off the same way.
- `bubble`: `points: [{ lon, lat, value, label }]`; area is proportional to value (0 is no bubble), the biggest are labelled where they fit. Prefer it when the value belongs to a place, or when a big empty region would dominate a choropleth. Above about 150 points, use `hexbin`.
- `connection`: `hubs: [{ id, label, lon, lat }]` and `links: [{ from, to, value? }]` between hub ids (at most 100 hubs, 200 links); each link is a great-circle arc as wide as its value, `directed: true` adds arrowheads. One row per pair: sum repeats first.
- `hexbin`: `points: [{ lon, lat, weight? }]`, up to 5,000 raw points, binned into hexagons (`radius` 8 to 40 px) coloured by count, or `aggregate: "sum"` / `"mean"` of `weight`. Send the raw points, not bins.
- `outline`: `highlight: [{ id, tone?, detail? }]` and `points: [{ lon, lat, label, tone? }]`; `tone` is said in words too.

Ids are what you'd write: ISO alpha-3 (`"PRT"`), alpha-2 (`"PT"`) or an English name for countries; postal code (`"PA"`), FIPS or name for states. An unknown id is refused with the nearest names. `view: [west, south, east, north]` overrides the fit; by default bubble, connection and hexbin maps fit most places and show "N outside view" for the far-off ones, and a world map zoomed to a country draws the detailed coast. No URLs, no colours, no formatters.

```json
{ "type": "map", "props": {
  "kind": "choropleth", "region": "us-states", "title": "2024 margin by state",
  "data": [{ "id": "PA", "value": 1.7, "detail": "R +1.7" }, { "id": "MI", "value": 1.4, "detail": "R +1.4" }, { "id": "VA", "value": -5.8, "detail": "D +5.8" }, { "id": "WY", "value": 46.1, "detail": "R +46.1" }],
  "scale": { "type": "diverging", "domain": [-20, 20], "midpoint": 0, "bins": 7, "unit": " pts" },
  "legend": { "title": "Margin (R + / D −)" } } }
```

```json
{ "type": "map", "props": {
  "kind": "bubble", "region": "europe", "title": "Store revenue by city", "unit": "M EUR",
  "points": [{ "lon": -9.14, "lat": 38.72, "label": "Lisbon", "value": 4.2 }, { "lon": 2.35, "lat": 48.86, "label": "Paris", "value": 7.9 }, { "lon": 13.4, "lat": 52.52, "label": "Berlin", "value": 3.1 }] } }
```

```json
{ "type": "map", "props": {
  "kind": "connection", "region": "world", "title": "Daily flights from Lisbon", "unit": " flights", "directed": true,
  "hubs": [{ "id": "LIS", "label": "Lisbon", "lon": -9.14, "lat": 38.77 }, { "id": "GRU", "label": "Sao Paulo", "lon": -46.47, "lat": -23.43 }, { "id": "JFK", "label": "New York", "lon": -73.78, "lat": 40.64 }],
  "links": [{ "from": "LIS", "to": "GRU", "value": 6 }, { "from": "LIS", "to": "JFK", "value": 9 }] } }
```

## Flow graphs

`flow` `kind: "sankey"`: nodes and links with values, bands as wide as their values, flowing one way: a cycle is refused (split the stage that repeats, e.g. `test` and `retest`). Node `tone` marks an outcome (`success`, `danger`). At most 200 nodes and 1,000 links. `kind: "network"`: things and their links, laid out by force; `group` colours nodes (at most 3 groups), `size` weights them, link `value` thickens lines. At most 500 nodes and 2,000 links; past a few hundred, aggregate. Both take arrows node to node and Enter along a node's links, and flip to a table.

```json
{ "type": "flow", "props": {
  "kind": "sankey", "unit": " jobs", "title": "CI runs by stage",
  "nodes": [{ "id": "push", "label": "Push" }, { "id": "lint", "label": "Lint" }, { "id": "test", "label": "Test" }, { "id": "build", "label": "Build" }, { "id": "pass", "label": "Passed", "tone": "success" }, { "id": "fail", "label": "Failed", "tone": "danger" }],
  "links": [{ "source": "push", "target": "lint", "value": 120 }, { "source": "push", "target": "test", "value": 120 }, { "source": "lint", "target": "pass", "value": 112 }, { "source": "lint", "target": "fail", "value": 8 }, { "source": "test", "target": "build", "value": 101 }, { "source": "test", "target": "fail", "value": 19 }, { "source": "build", "target": "pass", "value": 101 }] } }
```

```json
{ "type": "flow", "props": {
  "kind": "network", "title": "Service calls", "unit": " req/s",
  "nodes": [{ "id": "web", "group": "edge", "size": 3 }, { "id": "api", "group": "core", "size": 5 }, { "id": "auth", "group": "core", "size": 2 }, { "id": "db", "label": "postgres", "group": "data", "size": 4 }],
  "links": [{ "source": "web", "target": "api", "value": 900 }, { "source": "api", "target": "auth", "value": 700 }, { "source": "api", "target": "db", "value": 1500 }, { "source": "auth", "target": "db", "value": 300 }] } }
```

## Reference data, don't paste it

Every character of a `ui_render` call is something you generate, slowly, while the user watches the card say it is building. Never paste large data (diffs, logs, file contents, query results) into the JSON: name it, and yaah reads it itself, in the chat's folder, read-only, and keeps it fresh.

Showing what changed on this branch. Slow, and stale as soon as the next edit lands:

```json
{ "type": "patch", "props": { "title": "This branch", "text": "diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts\nindex 3b18e51..a4c09f2 100644\n--- a/src/billing/invoice.ts\n+++ b/src/billing/invoice.ts\n@@ -12,9 +12,12 @@\n-  const tax = subtotal * 0.2;\n+  const rate = taxRate(plan.country);\n… 2,000 more lines …" } }
```

Instant, with a file list, viewed ticks and "ask about this" on every hunk:

```json
{ "type": "diff-review", "props": { "range": "main...HEAD", "title": "Tax rates: this branch against main" } }
```

| To show | Don't paste | Reference |
| --- | --- | --- |
| A diff | its text in `patch` or `diff` | `diff-review` (`range`, `staged`, `paths`, `repo`), or `live` on `git.diff` |
| History | `git log` output | `live` on `git.log` (`range`, `limit`, `paths`) |
| Working tree | `git status` output | `live` on `git.status`, or `git-status` |
| A commit, or a committed file | `git show` output | `live` on `git.show` (`rev`, `path`), its `{{data.text}}` into `textfile` |
| A file you're working on | the whole file | only the lines that matter: `textfile` with its `path`, `start` and `highlight` |
| Query results | rows in a `table` | `live` on `postgres.query` (`connection`, `sql`), `{{data.rows}}` into a `table`, or `db-query` |
| Logs | the log text | `live` on `docker.logs` (`container`, `tail`), or `container-logs` |

`source_read` with the same source shows you the data first when you need to look before you design the UI; you don't have to repeat what it returned.

**Another repository.** Git sources and `diff-review` read the chat's own folder, or with `repo` (an absolute path or `~/…`) another of its folders: the ones the user added, or its project's repos. Anything else is refused. For a repository outside them ("the diff of my project in ~/work/api"), call `ui_request_folders { "paths": ["~/work/api"], "reason": "to review its diff" }` once: the user sees Add / Not now in the chat, and the answer comes back in the same turn. Then:

```json
{ "type": "diff-review", "props": { "repo": "~/work/api", "range": "HEAD~1", "title": "api: the last commit" } }
```

Never loop shell commands (`ls`, `find`, `git -C …`) to find or read a repository: each one stops for the user's permission. After Not now, don't ask again; carry on without it.

## When a call is refused

Errors start with "Fix these and call again" and name the path, the allowed props and the allowed values. Fix exactly those and call again; don't resend the same arguments. Send `tree`, `props` and `examples` as JSON objects, not strings. After three failed tries, render a simpler ad-hoc tree and say what you left out.

## Primitives

`*` marks required props.

{{primitives}}

## Components available now

{{components}}

Call `ui_catalog` for their descriptions and props schemas.
