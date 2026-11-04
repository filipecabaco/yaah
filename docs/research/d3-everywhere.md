# D3 flow graphs, and moving every graphic to d3

4 November 2026. Research only, no app code changed.

Anything not checked against a primary source is marked UNVERIFIED. Sizes were measured on 4 November 2026 with esbuild (`--minify`, ESM, gzip -9, React external) and from `pnpm exec vite build` on the current tree. `dist/` is git-ignored; no build output was left in git.

`docs/research/map-types.md` did not exist when this was written, so nothing here depends on it. The earlier review is `docs/research/maps-and-charts.md`.

## Status (4 November 2026, later the same day)

- **Steps 1 and 2**: done; **step 3**: the region maps are done, heatmap, bundle, chord and arc are not. The core (`ui-blocks/viz/`) carries the dumbbell, sankey, network and the maps (`docs/experiments/2026-11-04-d3-maps-flow/`), so the gate (3 or more kinds) is met.
- **Step 4**: done. Bar, line and area are React SVG on the core (`ui-blocks/chart.tsx`, geometry in `chart-geometry.ts`), with d3-scale 4.0.2 for scales and ticks and d3-shape 3.2.0 for line and area paths (`d3.stack` was not needed: stacking by sign is 20 lines in `stackRows`). Same props, same mark specs; the Recharts-tied tests were rewritten against our own `data-part` attributes and ARIA, and new ones cover keyboard focus, hover, the crosshair and Expand.
- **Step 5**: done. Recharts, `ui/chart.tsx`, the `.recharts-*` CSS and the `getBoundingClientRect` mock are gone; `ui-primitives.json` says `d3-scale`, `d3-shape`. Chart chunk 95.7 KB gz to 8.5 KB gz; the chart chunk no longer matches `Function(` in the CSP grep. `docs/experiments/2026-11-04-charts-on-d3/`.
- **Step 6**: done with step 4. Every category is a named list item in one roving tab stop (arrows, Home, End), the tooltip shows on focus as on hover, with the same words in the item's name.
- Sankey neutral bands now have 1px edges at 3:1 on the surface in every theme, over a quiet fill (`index.css`, `theme-contrast.test.ts` "flow bands").

## 1. Answers

**Q1. Do we have the Flow graphs?** No, not as primitives. The `chart` primitive is bar, line, area and dumbbell. Of the five Flow types (chord, network, sankey, arc, edge bundling), only two are reachable today, both through `diagram` (Mermaid 11.17.2):

- **Network graph**: partly. Mermaid `flowchart` draws nodes and links with a layered (dagre) layout, not a force layout. Fine for service maps and dependency trees, no good for hairballs.
- **Sankey**: partly. The build contains Mermaid's `sankey-beta` chunk (`sankeyDiagram-*.js`). It takes CSV text, not yaah props, has no table twin and no yaah colour tokens. I did not render one under the strict settings (UNVERIFIED that it draws cleanly).
- **Chord, arc, edge bundling**: none.

Recharts 3.8.0 also ships a `Sankey` component, but `chart.tsx` does not import it.

Agents in a coding context would use: **sankey** (CI stages, data pipelines, token or cost flow, test outcomes by suite), **network** (service call graphs, package dependencies, up to a few hundred nodes), **edge bundling** (module imports grouped by folder, the best answer to "who imports whom" on a big repo), **chord** (rarely: cross-team or cross-package coupling as a matrix), **arc** (rarely: ordered things such as a timeline of commits or lines with links between them). Priority: sankey, network, bundle, then arc and chord.

**Q2. Move fully to d3?** Yes in direction, no as a big-bang. Recommendation: **Option B, staged**. Build one small React-SVG core (scales, ticks, legend, tooltip, roving focus, table view, theme tokens) and put every *new* kind on it first (sankey, network, heatmap, maps, bundle). Keep Recharts for bar, line and area only until the core has shipped at least three kinds. Then port those three (the easy part) and delete Recharts and the shadcn chart wrapper. React owns the DOM; d3 only computes. Do not use d3-selection to draw.

Why not stop at Option A: the core is needed anyway. Dumbbell already re-built the legend, tooltip, roving focus, table view and axis outside Recharts, and Recharts needs about ten workarounds (section 4). Every new kind would copy that again. Why not do it all now: bar, line and area work, 20 of the 32 chart render tests are tied to Recharts' DOM, and nothing in the user's backlog is blocked by them.

Why not Option C: visx 4.0.0 and Observable Plot 0.6.17 each add a layer that yaah would then fight in the same places (section 5).

## 2. The D3 Graph Gallery "Flow" section

Fetched 4 November 2026. Section page: <https://d3-graph-gallery.com/index.html>. The gallery pages carry little detail; modules and data shapes below come from the pages and their basic examples. The layout cost column is my own assessment, not the gallery's (UNVERIFIED, nothing was benchmarked here).

| Type | What it shows | Data shape | d3 modules | In yaah today? | Coding use cases | Layout cost |
|---|---|---|---|---|---|---|
| Chord ([chord](https://d3-graph-gallery.com/chord.html), [basic](https://d3-graph-gallery.com/graph/chord_basic.html), [ticks](https://d3-graph-gallery.com/graph/chord_axis_labels.html), [colours](https://d3-graph-gallery.com/graph/chord_colors.html)) | Flow between groups on a circle. Gallery: "probably one of the most difficult graph to build with d3" | Square matrix of numbers (`matrix[i][j]` = flow i to j) plus a name per row | d3-chord (`chord().padAngle(0.05).sortSubgroups(d3.descending)`, `ribbon()`), d3-shape `arc()` | No | Coupling between packages or teams; module-to-module import counts when there are under about 20 groups | O(n²) in groups; cheap. Unreadable past about 20 |
| Network ([network](https://d3-graph-gallery.com/network.html), [basic](https://d3-graph-gallery.com/graph/network_basic.html)) | Entities and relationships; layout is the hard part | `{nodes:[{id,name}], links:[{source,target}]}` | d3-force (`forceSimulation`, `forceLink().id()`, `forceManyBody().strength(-400)`, `forceCenter`; also `forceCollide`, `forceX/Y`) | Partly: Mermaid flowchart (layered, not force) | Service call graphs, dependency graphs, who-calls-whom | Iterative: default about 300 ticks. For a static picture, run `simulation.tick(n)` synchronously and draw once. Fine to a few hundred nodes; a thousand is slow without a worker (UNVERIFIED) |
| Sankey ([sankey](https://d3-graph-gallery.com/sankey.html), [basic](https://d3-graph-gallery.com/graph/sankey_basic.html)) | Quantities flowing between stages | `{nodes:[{name}], links:[{source,target,value}]}` | d3-sankey (`sankey().nodeWidth().nodePadding().size()`, `sankeyLinkHorizontal`). The gallery example is the old API (`sankey.link()`, `layout(1)`) | Partly: Mermaid `sankey-beta` (CSV text); Recharts `Sankey` exists but is not wired | CI stages and pass/fail, data pipelines, request or cost flow, test outcomes by suite, token budget by step | A few relaxation passes over the links; trivial under about 1,000 links. Cycles are not allowed (the layout throws) |
| Arc ([arc](https://d3-graph-gallery.com/arc.html), [basic](https://d3-graph-gallery.com/graph/arc_basic.html), [vertical](https://d3-graph-gallery.com/graph/arc_vertical.html), [highlight](https://d3-graph-gallery.com/graph/arc_highlight.html), [template](https://d3-graph-gallery.com/graph/arc_template.html)) | A network with nodes on one axis and arcs between them | Same as network: `{nodes:[{id,name}], links:[{source,target}]}` | d3-scale `scalePoint` for positions and a plain SVG `A` path per link; no layout module | No | Calls between functions in file order, commits that touch the same file, co-change links in a timeline | O(nodes + links), no iteration. Node order decides legibility |
| Edge bundling ([bundle](https://d3-graph-gallery.com/bundle.html), [basic](https://d3-graph-gallery.com/graph/hierarchical_edge_bundling_basic.html)) | Links between leaves of a hierarchy, bundled along the tree | A hierarchy (from dotted names such as `flare.util.Arrays`) plus a list of links between leaves (`imports`) | d3-hierarchy (`hierarchy`, `cluster().size([360, innerRadius])`), d3-shape (`lineRadial`/`radialLine`, `curveBundle.beta(0.85)`) | No | Module imports grouped by folder or package, call graph by namespace | O(nodes) for the cluster, O(links × tree depth) for paths; cheap to a few thousand links |

The gallery's examples are d3 v4 to v6 and mutate the DOM with `d3.select`. We use only the maths from each, drawn by React.

### Example JSON in yaah's data-only style

Proposal only; nothing is in `ui-primitives.json` yet. A new `flow` primitive (or `chart` kinds `sankey` and `chord`; `network`, `arc`, `bundle` do not fit a rows-and-series shape, so a separate primitive is cleaner). Node ids are strings, rendered as text. Rust caps: 200 nodes, 1,000 links for sankey; 500 nodes, 2,000 links for network and bundle.

Sankey, CI run:

```json
{ "type": "flow", "props": {
  "kind": "sankey", "unit": " jobs",
  "nodes": [
    { "id": "push", "label": "Push" },
    { "id": "lint", "label": "Lint" },
    { "id": "test", "label": "Test" },
    { "id": "build", "label": "Build" },
    { "id": "pass", "label": "Passed" },
    { "id": "fail", "label": "Failed" }
  ],
  "links": [
    { "source": "push", "target": "lint", "value": 120 },
    { "source": "push", "target": "test", "value": 120 },
    { "source": "lint", "target": "pass", "value": 112 },
    { "source": "lint", "target": "fail", "value": 8 },
    { "source": "test", "target": "build", "value": 101 },
    { "source": "test", "target": "fail", "value": 19 },
    { "source": "build", "target": "pass", "value": 101 }
  ],
  "height": 320 } }
```

Network, service calls (`size` = node weight, `group` picks one of at most three categorical colours; same cap as maps and scatter):

```json
{ "type": "flow", "props": {
  "kind": "network", "height": 360,
  "nodes": [
    { "id": "web", "label": "web", "group": "edge", "size": 3 },
    { "id": "api", "label": "api", "group": "core", "size": 5 },
    { "id": "auth", "label": "auth", "group": "core", "size": 2 },
    { "id": "db", "label": "postgres", "group": "data", "size": 4 }
  ],
  "links": [
    { "source": "web", "target": "api", "value": 900 },
    { "source": "api", "target": "auth", "value": 700 },
    { "source": "api", "target": "db", "value": 1500 },
    { "source": "auth", "target": "db", "value": 300 }
  ] } }
```

Edge bundling takes the same `nodes` and `links`, plus a `parent` on each node (`"parent": "src/util"`), instead of dotted names. Chord takes `groups: ["a","b","c"]` and `matrix: [[0,5,2],[5,0,3],[2,3,0]]`.

All four keep the existing rules: ids and labels are text, numbers are range-checked, no URLs, no formatter strings. Every flow also gets the table toggle (source, target, value) and a keyboard path: sankey and network move focus node to node and then along its links; the tooltip content is the same on focus as on hover.

## 3. Inventory of graphics in yaah today

Line counts are from `wc -l` on 4 November 2026.

| Component | File | Lines | Library | Features |
|---|---|---|---|---|
| chart: bar, line, area | `ui-blocks/chart.tsx` | 589 | Recharts 3.8.0 via shadcn wrapper | Axes (own `axis` rule for ticks and domain, custom one-line tick), grid, tooltip (shadcn card), legend (2+ series, or when an end label was dropped), table toggle, end labels with leader lines, ref lines and labels, dodge, refs, animation off, `accessibilityLayer`, theme through CSS vars, `ResponsiveContainer` |
| chart: dumbbell | `ui-blocks/dumbbell.tsx` | 376 | d3-scale 4.0.2 + hand SVG | Own axis and grid, own tooltip (`placeTip`), legend and scale legend, table toggle (shared), roving focus with arrows (`role=list`, `tabIndex` on one row), `aria-label` per row, refs, gap labels, theme tokens |
| chart helpers | `chart-model.ts` 228, `chart-layout.ts` 124, `chart-font.ts` 21, `scale.ts` 99 | 472 | d3-scale | Pure: prop reading, caps, defaults per kind, label dodge, tip placement, font floor, colour scales |
| shadcn wrapper | `ui/chart.tsx` | 371 | Recharts | Container, config to CSS variables, tooltip content, legend content |
| palette | `lib/chart-palette.ts` | 307 | none | Theme-derived chart colours with CVD and contrast checks |
| map | `ui-blocks/map.tsx` 143, `map-fit.ts` 88, `map-a11y.ts` 28 | 259 | Leaflet 1.9.4, react-leaflet 5.0.0 | OSM tiles, circle markers, tooltip and popup, auto fit, link blocking |
| diagram | `ui-blocks/diagram.tsx` 68, `diagram-cache.ts` 54, `svg-clean.ts` 52 | 174 | Mermaid 11.17.2 | Strict security level, per-theme cache, SVG cleaning. Not used in `markdown.tsx` (no mermaid fences) |
| git graph | `ui-blocks/cli/views.tsx` (`GraphCell`, `GitGraphView`, about 100 lines) | about 100 | none | Hand SVG per row from `git log --graph` text; lines, circles, `--chart-1..5` lane colours; `aria-hidden`, no hit targets |
| progress | `ui/progress.tsx` via `ui-render.tsx` | small | shadcn / Radix | Bar with `aria-label` |
| brand mark | `components/brand/mark.tsx` | small | none | Static SVG |

Not found: sparklines, diff-stat bars (`DiffStatView` uses text and DOM, not SVG; UNVERIFIED in detail), `stat` trend graphics (the `stat` primitive has only `trend: up|down|flat` as an enum).

Where bar, line and area differ from dumbbell: Recharts gives them keyboard and screen-reader hooks through `accessibilityLayer` (arrow keys move the tooltip between points; ARIA roles added by Recharts, not by us). Dumbbell has hand-built roving focus with its own tests. Both use the same table toggle, theme tokens, mark specs and `needsLegend`.

Tests that depend on the Recharts DOM:

- `ui-blocks/chart.test.tsx`, 483 lines, 32 tests. About 20 (from "solid hairline grid" to "never wraps a tick label", plus the font and axis ones) query `.recharts-*` classes and need the `getBoundingClientRect` mock plus a wait for the clip path; 26 selector hits. About 12 are dumbbell or pure and survive.
- `chart-gallery.test.tsx` (1 test) and `election-dashboard.test.tsx` (1 test): render charts through the full tree; expected to survive if the output is still an SVG with the same labels (UNVERIFIED, not read in detail).
- Pure and unaffected: `chart-model.test.ts` (6), `chart-layout.test.ts` (13), `scale.test.ts` (4), `chart-palette.test.ts`.

## 4. Where Recharts is fought today

From `chart.tsx`, `ui/chart.tsx` and the test:

1. **Tick text**: Recharts wraps a tick at spaces (`-10 / °C`); `tick()` replaces it so every tick is one line in a text token.
2. **Axis domain and ticks**: `axis.domain`, `axis.ticks`, `interval={0}` override Recharts' own tick choice to get "bars start at zero" and "fit lines to data".
3. **Axis widths**: `catW` and `valueW` are computed by us so labels are not clipped.
4. **End labels and ref labels**: `SideLabels` and `TopLabels` use Recharts internals (`ZIndexLayer`, `useXAxisScale`, `usePlotArea`, `useChartWidth`) to draw outside the plot, then our `dodge`. These hooks are the part most likely to break on a Recharts upgrade (UNVERIFIED whether they are public API).
5. **Ref lines**: `ReferenceLine` with `zIndex` tuned (350 vs 50) to sit over bars and under lines.
6. **Legend**: `itemSorter={null}` because Recharts sorts by name; a legend swatch fix in `ui/chart.tsx` (`backgroundColor: itemConfig?.color ?? item.color`) because a stacked area's stroke is the surface seam, not the series colour.
7. **Tooltip**: custom `formatter` replaces the shadcn row to keep our swatch and tabular numbers.
8. **shadcn CSS overrides** on Recharts' hard-coded colours: attribute selectors for `#ccc` and `#fff`, `.recharts-*` class overrides in the container class.
9. **Series keys**: shadcn writes config keys into a `<style>` block, so field names are rekeyed to our own slot names to keep agent text out of CSS.
10. **Animation**: `isAnimationActive={false}` on every series.
11. **Mark specs**: 24px bar cap, 2px surface gap, 8px dots with a 2px ring, solid grid: each was fought through props or CSS (see the tests that assert them).
12. **Tests**: `getBoundingClientRect` mock and a wait for the clip path because Recharts draws after its own layout pass.

The dodge, font, tip placement and model code are ours and carry over to any renderer. Items 1, 2, 3, 6, 7, 8, 9, 10 and 12 disappear with Recharts; 4 and 5 become ordinary SVG.

## 5. Options

### Option A: keep Recharts for bar, line, area; d3 maths plus hand SVG for the rest

Today's recommendation from `maps-and-charts.md`. Each new kind is its own component; shared parts (legend, tooltip, focus, table, axis) grow by copy.

### Option B: one React-SVG layer on d3 maths, drop Recharts

Packages: d3-scale, d3-shape, d3-array, d3-geo, d3-sankey, d3-chord, d3-force, d3-hierarchy. Ticks and axes: use d3-scale `scale.ticks()` and `tickFormat` and draw them in React; skip d3-axis (it needs d3-selection and draws the DOM). d3-hexbin 0.2.2 is 0.7 KB gz but dates from 2017; fine to use or to write by hand (about 30 lines).

### Option C: a library on d3

- **visx 4.0.0** (published 11 June 2026, MIT): React SVG primitives. `@visx/shape` alone is 4.3 KB gz; a realistic set (shape, scale, axis, tooltip) is 25.4 KB gz. Safe for CSP, themeable with CSS vars. But `@visx/vendor` pins old d3 copies (d3-array 3.2.1, d3-scale 4.0.2, d3-shape 3.2.0, d3-geo 3.1.0 and others), so we would carry a second set of d3 modules next to the ones we use for sankey and geo. No sankey or chord in `@visx/shape` 4.0.0 (an import of `Sankey` fails). It gives pieces, not charts, so we would still write the legend, tooltip, focus and table.
- **Observable Plot 0.6.17** (ISC): 133 KB gz, whole package, depends on d3 7.9. JS API, not data: a mapping layer is needed anyway. It builds DOM with the document API, not React (so React does not own the output), and happy-dom layout is again a problem (UNVERIFIED). No sankey, chord, force or bundle marks in 0.6.x (UNVERIFIED against the docs; not fetched).

### Comparison

| | A: Recharts + d3 for the rest | B: React SVG on d3 maths | C: visx or Plot |
|---|---|---|---|
| Bundle | Recharts about 90 to 100 KB gz stays (see below); every new kind adds its own d3 module | Saves that Recharts share; core adds about 6 to 10 KB gz of our code (estimate) | visx 25 KB gz for a set, with duplicate d3 copies; Plot 133 KB |
| Consistency | Two looks, two tooltips, two focus models | One | One per library, but not ours: tooltip, legend, table still ours |
| Control | Ten workarounds stay; Recharts upgrades can break the label hooks | Full | visx: full, you own the layer. Plot: little |
| A11y | `accessibilityLayer` for three kinds, hand roving focus for the rest | One roving-focus model, tested once | visx: hand-built. Plot: aria-label on marks, no roving focus (UNVERIFIED) |
| Effort | None now; each new kind M | Core M, ports S to M each | Core M plus integration; no saving over B |
| Risk | Low now, drift later | Medium: regressions in three working charts, a11y loss if the port is careless | Same as B plus a dependency we do not control |
| 2,000 rows | Recharts renders each mark as React elements plus redux state; works, not measured here | React SVG: 2,000 `<rect>`s is fine; line and area are one `<path>`. Scatter or heatmap past about 5,000 marks needs canvas or binning. UNVERIFIED, not benchmarked | Same as B |
| happy-dom (no layout) | Needs the `getBoundingClientRect` mock and waits | Our own `ResizeObserver` size hook: tests pass a width; deterministic | Plot: same trouble |
| Maintenance | Recharts 3.x moves fast (3.10.1 is the newest 2+ weeks old; 3.11 canaries exist); its deps include redux toolkit, immer, reselect | We own about 1,500 lines; d3 modules are stable (most untouched since 2021 to 2023) | One more upstream |

**Bundle, measured.** `pnpm exec vite build` gives `chart-*.js` = 345.9 KB raw, **99.1 KB gz**. That chunk holds Recharts, d3-scale, `chart.tsx`, the dumbbell, the shadcn wrapper and the helpers. Bundling only the Recharts names `chart.tsx` imports with esbuild gives 386 KB raw, 112.8 KB gz (esbuild tree-shakes it less well than Vite does here). So Recharts is roughly 85 to 95 KB gz of the 99 KB chunk (estimate; the exact split was not isolated). The chunk is lazy, so it costs on the first chart, not on startup. For scale: `index-*.js` (the app) is 258 KB gz, `map-*.js` 46.5 KB gz, and Mermaid's chunks are far larger (cytoscape 137.7 KB gz alone).

The d3 pieces for Option B, measured the same way (names used):

| Module | gz |
|---|---|
| d3-scale | 13.6 KB (already shipped) |
| d3-shape | 5.2 KB |
| d3-array | 1.6 KB |
| d3-geo | 9.1 KB |
| d3-sankey | 2.8 KB (plus older d3-array 2.x and d3-shape 1.x copies, about 4 KB more, see section 6) |
| d3-chord | 2.2 KB |
| d3-force | 5.5 KB |
| d3-hierarchy | 5.3 KB |
| d3-hexbin | 0.7 KB |

All new modules together: about 30 KB gz, and each loads with its own lazy block. Option B ends smaller than today's chart chunk even with every flow kind added.

## 6. Recommendation and plan

**Option B, staged, with a gate.** React renders; d3 computes (scales, ticks, shapes, layouts). No `d3-selection`, no `d3-axis`, no `.append()`. An imperative rewrite is the main risk and is not part of this plan.

### Shared core (`ui-blocks/viz/`)

| Piece | From | Notes |
|---|---|---|
| `useSize` | new | `ResizeObserver` on the card; tests pass a fixed size, no mocks |
| `Axis` (ticks, grid, one-line labels) | `tick()`, `axis`, `valueW` in `chart.tsx` | Uses `scale.ticks()` and our axis rule; solid hairline grid |
| `Legend`, `ScaleLegend` | dumbbell, `needsLegend` | One component for charts, maps, flows |
| `Tooltip` + `placeTip` | dumbbell, `chart-layout.ts` | Same content on focus and hover |
| `useRovingFocus` | dumbbell rows | One tabbable item, arrows, Home and End; also the model for node-to-node in flows |
| `DataTable` toggle | `chart.tsx` table | Same for every kind, including flows and maps |
| `dodge`, `fitText`, `chartFontPx` | `chart-layout.ts` | Unchanged |
| Tokens | `scale.ts`, `lib/chart-palette.ts` | Unchanged; marks use `var(--chart-n)` and `--scale-*` |
| Mark specs | tests in `chart.test.tsx` | 24 px bar cap, 2 px gap, 2 px line, 8 px dots with ring, 10% area wash |

### Order, effort and test strategy

| Step | Work | Size | Tests |
|---|---|---|---|
| 1 | Extract the core from dumbbell and `chart.tsx`; dumbbell moves onto it | M | Dumbbell tests stay green unchanged; add unit tests for `useRovingFocus`, `Axis` tick choice |
| 2 | Sankey (d3-sankey) and network (d3-force, static `tick(n)`), with table and focus | M each | Pure layout tests (node and link positions for a fixed input, determinism); DOM tests for labels, ARIA, tooltip on focus |
| 3 | Heatmap, maps via the choropleth plan (d3-geo), bundle (d3-hierarchy), chord, arc | M, M, S, S, S | Same pattern; no layout mocks |
| **Gate** | Core has shipped 3 or more kinds, and the shared tests pass. If not, stop here: Option A is still fine | | |
| 4 | Port **bar**, then **area**, then **line** to the core (d3-shape for line and area; stacks via `d3.stack` from d3-shape) | S, M, M | Rewrite the 20 Recharts-tied tests to assert on our own `data-part` attributes (`grid`, `axis`, `end-label`, `ref-label`, `leader` already exist for dumbbell); keep the same mark-spec assertions |
| 5 | Remove Recharts, `ui/chart.tsx`, the `.recharts-*` CSS, the `getBoundingClientRect` mock; update `ui-primitives.json` `uses` | S | Full test run; compare screenshots of old and new (light and dark) under `docs/experiments/` |
| 6 | Keyboard and screen-reader pass on ported charts (what `accessibilityLayer` gave for free) | S | Add tests: arrow keys, `aria-label` per mark, focus ring |

Steps 4 to 5 are the only part that touches working charts; that is why they sit behind the gate.

### What not to do

- Do not rewrite with d3-selection or `.join()`; two owners of the DOM is how leaks and test pain start.
- Do not port bar, line and area first. They are the least valuable to move and the most tested.
- Do not use d3-axis, d3-zoom, d3-transition or d3-drag. No animation (already off), no zoom in v1.
- Do not run force layout on every render. Compute once per data change (`useMemo`), run `tick(n)` synchronously, cap nodes, and draw the settled layout.
- Do not add Vega, ECharts, Nivo, visx or Plot. Prior decisions stand.
- Do not drop the table toggle or the keyboard path when porting; they are the a11y floor.
- Do not mix the `d3-*` majors: use the exact pins below.

### Security and CSP

All modules are eval-free (React plus SVG). `script-src 'self'` stays; no `unsafe-eval`. Labels are text. Sankey cycles must be caught and shown as an error card with a message the agent can read. Rust caps rows, nodes and links (section 2).

## 7. Versions

Every pin was published at least two weeks before 4 November 2026 (cutoff 21 October 2026), from `npm view <pkg> time --json`. On **3 November 2026** npm shows a wave of new patch releases across d3 packages (d3-geo 3.1.2, d3-scale 4.0.3, d3-shape 3.2.1, d3-array 3.2.5, d3-hierarchy 3.1.3, d3-force 3.0.1, d3-chord 3.0.2, d3-axis 3.0.1, d3-path 3.1.1, d3-interpolate 3.0.2, d3-time 3.1.1, d3-time-format 4.1.1, d3-format 3.1.3, d3-delaunay 6.0.5 and 6.0.6, d3-quadtree 3.0.2, d3-zoom 3.0.1, d3-selection 3.0.1, d3-contour 4.0.3). All of these are inside the two-week window and **skipped**. Pin exact versions (no `^`).

| Package | Pin | Published | Licence | gz (names used) | Use |
|---|---|---|---|---|---|
| d3-scale | 4.0.2 | 2021-09-24 | ISC | 13.6 KB | already installed; scales, ticks, colour scales |
| d3-shape | 3.2.0 | 2022-12-20 | ISC | 5.2 KB | line, area, stack, arc, `curveBundle`, `lineRadial` |
| d3-array | 3.2.4 | 2023-05-30 | ISC | 1.6 KB | extent, bin, ticks |
| d3-path | 3.1.0 | 2022-12-19 | ISC | via d3-shape | dependency of d3-shape 3.2.0 |
| d3-geo | 3.1.1 | 2024-03-12 | ISC | 9.1 KB | maps (do **not** take 3.1.2) |
| topojson-client | 3.1.0 | 2019-11-06 | ISC | 2.6 KB | maps (from the earlier review) |
| d3-sankey | 0.12.3 | 2019-09-02 | BSD-3-Clause | 2.8 KB | sankey |
| d3-chord | 3.0.1 | 2021-06-05 | ISC | 2.2 KB | chord |
| d3-force | 3.0.0 | 2021-06-05 | ISC | 5.5 KB | network (pulls d3-timer, d3-dispatch, d3-quadtree) |
| d3-hierarchy | 3.1.2 | 2022-04-02 | ISC | 5.3 KB | treemap, cluster for bundling |
| d3-hexbin | 0.2.2 | 2017-03-28 | BSD-3-Clause | 0.7 KB | optional; abandoned since 2017, or write by hand |

Notes:

- **d3-sankey 0.12.3** is the newest release and is from 2019. It depends on `d3-array 1 - 2` and `d3-shape ^1.2.0`, so the tree gets old copies next to d3-array 3.2.4 and d3-shape 3.2.0 (the repo already has d3-array 2.12.1 and d3-shape 1.3.7 installed through it). Cost about 4 KB gz. Types come from `@types/d3-sankey` (0.12.5 on npm; check the publish date before pinning, UNVERIFIED). If the duplicate bothers us, the layout is small enough to vendor.
- **d3-axis, d3-selection, d3-zoom, d3-transition**: not needed; leave them out.
- **Recharts**: stayed on 3.8.0 until step 5, then removed (see Status).
- **d3-shape 3.2.0** depends on `d3-path ^3.1.0`; 3.1.1 is from 3 November 2026, so `pnpm-workspace.yaml` overrides `d3-path@3` to 3.1.0. `@types/d3-shape` 3.2.0 is from 21 August 2026.
- Licences are from the npm registry. All are permissive (ISC or BSD-3-Clause), no attribution beyond the notice in the package.
- Bundled geodata (us-atlas 3.0.1, world-atlas 2.0.2) is unchanged from `maps-and-charts.md`.

## 8. Not verified

- Mermaid `sankey-beta` rendering under yaah's strict settings: only that its chunk is in the build.
- Layout speed of force and sankey at scale: no benchmark was run.
- Whether `ZIndexLayer`, `useXAxisScale`, `usePlotArea` are public Recharts API.
- Observable Plot's lack of sankey, chord, force and bundle marks, and its a11y behaviour: not checked against its docs.
- `DiffStatView` internals; `chart-gallery` and `election-dashboard` tests in detail.
- Whether `@types/d3-sankey` 0.12.5 is old enough.
- The 85 to 95 KB gz Recharts share is an estimate from two measurements, not an isolated build.

## 9. Sources

- yaah: `app/src/components/ui-blocks/chart.tsx`, `chart-layout.ts`, `chart-model.ts`, `dumbbell.tsx`, `diagram.tsx`, `map.tsx`, `cli/views.tsx` (`GitGraphView`), `app/src/components/ui/chart.tsx`, `chart.test.tsx`, `app/src/ui-primitives.json`, `app/package.json`; `docs/research/maps-and-charts.md`.
- D3 Graph Gallery (fetched 4 November 2026):
  - <https://d3-graph-gallery.com/index.html>
  - <https://d3-graph-gallery.com/chord.html>
  - <https://d3-graph-gallery.com/graph/chord_basic.html>
  - <https://d3-graph-gallery.com/graph/chord_axis_labels.html> and <https://d3-graph-gallery.com/graph/chord_colors.html> (named on the chord page; not fetched themselves)
  - <https://d3-graph-gallery.com/network.html>
  - <https://d3-graph-gallery.com/graph/network_basic.html>
  - <https://d3-graph-gallery.com/sankey.html>
  - <https://d3-graph-gallery.com/graph/sankey_basic.html>
  - <https://d3-graph-gallery.com/arc.html>
  - <https://d3-graph-gallery.com/graph/arc_basic.html> (the vertical, highlight and template pages were listed on the arc page; not fetched)
  - <https://d3-graph-gallery.com/bundle.html>
  - <https://d3-graph-gallery.com/graph/hierarchical_edge_bundling_basic.html>
- Page fetching used the WebFetch tool (no `fetch` MCP server was available in this session); its summaries were checked against each page's own code where quoted.
- npm registry (`npm view <pkg> time`, `license`, `dependencies`), queried 4 November 2026.
- Measurements: esbuild bundles in the session scratchpad, and `pnpm exec vite build` on the current tree.
