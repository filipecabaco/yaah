# Maps and charts for agent-built UI

4 November 2026. Research only, no code changed.

Trigger: an agent built a US election dashboard (tabs, stat tiles, a Leaflet map with coloured markers on OpenStreetMap tiles, a grouped bar chart of poll margin vs result margin). An election map wants states filled by value. The user asked for more map views and graph styles.

Sizes below were measured on 4 November 2026 by bundling each package with esbuild (`--minify`) and gzip -9. They are whole-package numbers; tree-shaken use will be smaller. Anything not checked against a primary source is marked UNVERIFIED.

## 1. What yaah has today

Both primitives are lazy-loaded React blocks fed by plain JSON props. Rust validates trees against `app/src/ui-primitives.json`; React renders in `app/src/components/ui-render.tsx`.

**chart** (`ui-blocks/chart.tsx`, Recharts 3.8.0 through shadcn's chart wrapper)
- `kind`: `bar`, `line`, `area`. Nothing else.
- Props: `data` (rows), `x`, `series` (max 5, extras folded into "Other"), `stacked`, `unit`, `height`.
- Good: one y axis only, fixed palette slots `--chart-1..5`, legend for 2+ series, tooltip, chart/table toggle, negative stacking, auto-horizontal bars when labels are long, field names rekeyed so agent text never reaches CSS or Recharts paths.
- Missing: scatter, bubble, histogram, box, heatmap, treemap, sankey, funnel, radar, gauge, candlestick, waterfall, dumbbell, slope, small multiples, sparklines in tables, reference lines, annotations, direct labels, per-point colour, x as a number/time scale, bar thickness and 2px gaps from the dataviz spec, dashed grid is used (dataviz says solid).

**map** (`ui-blocks/map.tsx`, Leaflet 1.9.4 + react-leaflet 5.0.0)
- One mode: circle markers (radius 8) with `label` (tooltip), `detail` (popup), `tone` (default / success / warning / danger) on OpenStreetMap raster tiles.
- Props: `markers`, `center`, `zoom`, `height`. Auto fit to markers. Scroll-wheel zoom off.
- The tile URL is fixed in code (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`), so an agent cannot point the map at another host. Links inside the map are blocked by `keepLinksOutside`.
- Missing: any fill by region, outline-only/offline mode, legend, colour scale, size by value, lines, heatmap, clusters, GeoJSON.

**Remote loading rules** (`app/src-tauri/tauri.conf.json`): `img-src 'self' data: blob: https:`, `connect-src 'self' ipc: http://ipc.localhost`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `font-src 'self' data:`. So OSM tiles load as `<img>` over https; nothing can `fetch` a remote file. A GeoJSON/TopoJSON file must be bundled or passed inline. `script-src 'self'` has no `unsafe-eval`, which rules out any library that builds functions at runtime unless it has a CSP-safe path (see section 3).

Other relevant primitives: `stat`, `tabs`/`tab`, `table`, `diagram` (Mermaid 11.17.2), `progress`. `live` binds `{{data}}` and `{{history}}` into children.

## 2. Maps

### Views worth supporting

| View | Data-only shape | Notes |
|---|---|---|
| Choropleth, US states | `region: "us-states"`, rows `{id, value}` | us-atlas `states-albers-10m.json`, 82 KB raw / 29.5 KB gz, already projected (Albers USA, Alaska/Hawaii inset). Source: US Census Bureau cartographic boundaries 2017, ISC wrapper (UNVERIFIED that Census data itself has no restriction; US federal data is generally public domain). |
| Choropleth, US counties | `region: "us-counties"` | `counties-albers-10m.json` 795 KB raw. Load lazily, only when asked. |
| Choropleth, world countries | `region: "world"` | world-atlas `countries-110m` 108 KB raw / 38 KB gz; `countries-50m` 756 KB / 230 KB gz. Natural Earth, public domain, no attribution needed (checked on naturalearthdata.com terms page). Disputed borders are Natural Earth's choices; note that in the guide. |
| Admin-1 (provinces, states) | `region: "admin1:<ISO country>"` | Natural Earth admin-1 is large (the 10m file is tens of MB as shapefile, UNVERIFIED). Feasible only as a build-time split into one simplified TopoJSON per country, loaded on demand. Phase 3. |
| Agent-supplied GeoJSON | `geojson: {...}` inline | Allowed with limits (below). Needed for anything we do not bundle. |
| Hex / tile cartogram | `region: "us-tiles"` or `layout: "tile-grid"` | A table of ~51 `{id, col, row}` cells (NPR / FiveThirtyEight style). No geodata licence issue: we author the grid ourselves. Renders as SVG squares or hexes. The right default for elections: every state gets equal area, so small states are visible. |
| Proportional symbols | `symbols: [{lat,lng,value,label}]`, sized by sqrt(value) | Works on any base. |
| Heatmap (density) | `heat: [{lat,lng,weight}]` | Leaflet-only (leaflet.heat) or hand-drawn canvas. Lower priority, and a poor fit for outline-only mode. |
| Lines / arcs | `links: [{from:[lat,lng], to:[lat,lng], value}]` | Great-circle arcs via d3-geo `geoInterpolate`, drawn as SVG paths. |
| Clusters | `cluster: true` on markers | leaflet.markercluster 1.5.3, 9 KB gz. Only for the tile map. |
| Outline-only, no tiles | `basemap: "none"` | SVG from d3-geo. No tile requests, works offline, themeable with CSS variables. Should be the default for region maps. |
| Labels, legend, scales | `legend`, `labels`, `scale: {type, domain, steps}` | See colour scales below. |

### Colour scales (from the dataviz skill)

- `sequential`: one hue, light to dark, steps 100 to 700 (`palette.md` gives the blue ramp). Default.
- `diverging`: blue to red with a neutral gray midpoint (`#f0efec` light, `#383835` dark), equal steps each side. This is what a margin map needs (D+ to R+). Note US convention is blue Democrat / red Republican; the pair is the documented diverging pair, so it fits. Never use red/blue for non-polar data.
- `categorical`: at most three classes on a map (the all-pairs CVD limit in the skill). Past that, bin into a table or small multiples.
- `bins`: 5 to 7 classes maximum, with a legend showing the thresholds. No continuous colour without a legend.
- Colours are CSS variables (`--chart-*`, new `--scale-seq-100..700`, `--scale-div-*`), so light/dark and theme switches repaint with no re-render logic.

### Library comparison (maps)

| Option | gzip | Licence | Offline | Theming with CSS vars | A11y | Data-only fit | Verdict |
|---|---|---|---|---|---|---|---|
| d3-geo 3.1.1 + topojson-client 3.1.0 + SVG | 14.6 KB + 2.6 KB | ISC | Yes, fully | Yes, SVG `fill: var(--x)` | Good: real DOM, `role`, `aria-label` per region, keyboard focus possible | Excellent: props map straight to paths | **Adopt** for choropleth, tile cartogram, symbols, arcs, outline mode |
| Leaflet 1.9.4 (current) | 43 KB (already shipped) | BSD-2 | Only if tiles are not used | Partly (tooltips/popups are DOM, vectors are SVG) | Weak: keyboard focus on markers is limited | Fine for markers | **Keep** for the tile basemap mode only |
| Leaflet GeoJSON layer + plugins | 43 KB + 9 KB (cluster) | BSD/MIT | Tiles needed for context | Partial | Weak | OK | Use for clusters on tile map. leaflet.heat 1.0.0 is old (2015-era, UNVERIFIED maintenance). |
| MapLibre GL 6.15.0 | 296 KB | BSD-3 | Needs a style + vector tiles (or local PMTiles) | Style JSON, not CSS vars | Canvas, poor | Style JSON is data but huge surface; sources fetch from `connect-src`, which is blocked | Skip. Heavy, needs network or bundled tiles. |
| deck.gl 9.4.0 | not measured (several hundred KB, UNVERIFIED) | MIT | Needs base map for context | No | Canvas, poor | Good for 100k+ points | Skip. Overkill. |
| react-simple-maps 5.0.5 | 40 KB (includes its d3 deps) | MIT | Yes | Yes, SVG | OK | Fine, but a thin wrapper over d3-geo | Skip. We would write the same 150 lines ourselves and avoid a dependency. Check React 19 peer range (UNVERIFIED). |
| Observable Plot 0.6.17 geo marks | 130 KB | ISC | Yes | SVG, CSS vars usable | Decent (aria-label on marks) | Plot is JS API, not JSON; would need a mapping layer anyway | Skip for maps; d3-geo is a smaller path to the same result. |

Projection choices for the d3-geo renderer: `geoAlbersUsa` for the US (pre-projected files can skip the projection), `geoNaturalEarth1` for the world, `geoMercator` as a fallback. All are in d3-geo.

### GeoJSON limits (agent-supplied)

- Inline only (no URL), max 500 KB serialised, max 5,000 features, max 200,000 coordinates; reject otherwise with a message the agent can read.
- Types: Polygon, MultiPolygon, LineString, MultiLineString, Point, MultiPoint, Feature, FeatureCollection. Reject GeometryCollection nesting beyond depth 2.
- Validate coordinates: finite numbers, lon -180..180, lat -90..90.
- Properties are read only through a declared `idField` and `valueField`; label text is rendered as text, never HTML.
- Optional simplification with `@turf/simplify` (part of turf 7.4.0) if over the vertex budget. UNVERIFIED whether worth the bundle cost; a Douglas-Peucker in 30 lines is an alternative.

## 3. Charts

### Styles worth supporting, and where they come from

| Style | In Recharts? | Plan |
|---|---|---|
| Bar grouped, stacked, horizontal | Yes | Keep. Add explicit `orientation`. |
| Diverging bar | Partly (negative values) | Add `kind:"bar"`, `baseline: 0`, two-tone fill by sign. |
| Line, area, stacked area | Yes | Keep. Dataviz says area wash ~10% opacity; current is 20%. |
| Scatter / bubble | Yes (`ScatterChart`, `ZAxis`) | Add `kind:"scatter"`; cap 3 colour classes. |
| Histogram | No, but trivial: bin then bar | Bin in the mapping layer (`kind:"histogram"`, `bins`). |
| Box plot | No | Draw in SVG from precomputed quartiles, or bar+error composition. |
| Heatmap / calendar | No | Custom SVG grid with the sequential scale. |
| Treemap | Yes (`Treemap`) | Use it, or d3-hierarchy 3.1.2 (5.8 KB gz) for control. |
| Sunburst | Yes (`SunburstChart`, UNVERIFIED in 3.8.0) | Optional. |
| Sankey | Yes (`Sankey`) | Use it. d3-sankey 0.12.3 is 2.9 KB gz if we outgrow it. |
| Funnel | Yes (`FunnelChart`) | Ordinal one-hue ramp, per dataviz. |
| Radar | Yes | Low priority; dataviz has no radar rule (UNVERIFIED). |
| Gauge / KPI | No | `stat` + `progress` already cover it; add sparkline to `stat`. |
| Candlestick | No | Custom shape on `Bar`/`ComposedChart`. Low priority for a coding tool. |
| Waterfall | No | Stacked bar with invisible base series. |
| Dumbbell / dot plot | No | Custom SVG (two dots and a connector). Best form for poll vs result. |
| Slope chart | No | Two-column SVG lines. |
| Small multiples | No | `facet` field: render N small charts in a grid with shared scales. |
| Sparkline | No | Tiny SVG path; allow in `table` cells and `stat`. |
| Reference lines / annotations | Yes (`ReferenceLine`, `ReferenceArea`) | Add `refs: [{y, label}]`, `notes: [{x, y, text}]`. |

### Library comparison (charts)

| Option | gzip (measured) | Licence | JSON-only spec | CSP safety (no eval) | Theming | A11y | Mapping layer needed |
|---|---|---|---|---|---|---|---|
| Recharts 3.8.0 (current; 3.10.1 is the newest 2+ weeks old) | 167 KB whole, already shipped | MIT | No, but our props already map 1:1 | Safe (React/SVG, no eval) | CSS vars via shadcn wrapper | `accessibilityLayer` | Already exists; extend it |
| Observable Plot 0.6.17 | 130 KB | ISC | No (JS marks API) | Safe | SVG, CSS vars | Good | Medium; would replace Recharts |
| Vega-Lite 6.5.0 + Vega 6.4.0 | 266 KB + 187 KB | BSD-3 | **Yes, native JSON** | Default path uses `new Function`. `vega-interpreter` 2.3.2 (6 KB gz) walks the AST instead and is the documented CSP route (Vega docs). Docs do not state that eval is entirely absent, so test with a strict CSP before trusting it. About 10% slower. | Config JSON; can inject CSS var values | SVG output, ARIA support exists (UNVERIFIED depth) | Small, but needs a spec **linter** (strip `data.url`, `href`, `calculate`/`filter` strings, `signals`, `loess`). Large surface to defend. |
| ECharts 6.1.0 | 382 KB | Apache-2.0 | Option object is JSON-like | Formatters can be functions; string templates also exist. Does not need `unsafe-eval` as far as known (UNVERIFIED) | Theme JSON; no CSS vars natively | Has an aria module | Medium; canvas by default (SVG renderer available) |
| Chart.js 4.5.1 | 70 KB | MIT | Config object, callbacks optional | Safe | Canvas, hex colours must be resolved from CSS vars in JS | Poor (canvas) | Medium |
| visx 4.0.0 | modular, small per piece (UNVERIFIED) | MIT | No (React primitives) | Safe | SVG, CSS vars | Good | Large; we would write each chart |
| Nivo 0.99.0 | not measured | MIT | Props only, in React | Safe | Theme object | Fair | Medium; adds a second chart stack |

Decision logic: staying on Recharts for standard cartesian charts keeps one dependency, one theming path, and the shadcn tooltip/legend. Custom styles (dumbbell, slope, heatmap, sparkline, box, waterfall) are small hand-written SVG components using d3-scale (19.7 KB gz) and d3-shape (8.6 KB gz), which also supplies the geo and tile cartogram scales. Vega-Lite would be the cleanest "JSON grammar" story, but the expression language is exactly the thing the "nothing runs" rule exists to avoid, and the full stack is 450 KB gz. Not worth it.

### Prior art

Only the first two were fetched; the rest are from memory and UNVERIFIED.

- Vercel json-render: a catalog of developer-defined components with Zod-checked props; its listed chart components are BarGraph and LineGraph; no map listed. Same model as yaah.
- Google A2UI: declarative component JSON, client-owned catalog. Charts and maps appear as custom client components, not in the base catalog. Same model.
- Claude artifacts: the model writes HTML/React that runs in a sandbox, with Recharts and others available (UNVERIFIED). Different model: it runs code.
- ChatGPT data analysis: Python-rendered images, plus newer interactive tables and charts of a handful of types (bar, line, pie, scatter) (UNVERIFIED).
- MCP Apps: servers ship sandboxed HTML views to the host (UNVERIFIED). Code, not data.
- Observable notebooks: Plot and d3 as JS code (UNVERIFIED).

Takeaway: the data-only peers ship very small vocabularies (2 chart kinds, maps as client extensions). yaah is already ahead; the gap is region maps and chart variety.

## 4. Recommended vocabulary

Principle: keep `chart` and `map` as the two entry points, widen their `kind`/`mode` enums, and add one small shared sub-vocabulary (`scale`, `legend`, `refs`, `notes`). Where a mode has very different props (map regions, dumbbell), validate props per `kind`/`mode` in Rust.

### map

New props (all optional, old calls still work):

| Prop | Values | Notes |
|---|---|---|
| `mode` | `markers` (default, today's behaviour), `choropleth`, `tiles-grid`, `symbols`, `arcs` | |
| `basemap` | `osm` (default for `markers`), `none` (default for others) | `none` makes no network request. |
| `region` | `us-states`, `us-counties`, `world`, or `{geojson}` | |
| `data` | `[{id, value, label?, detail?}]` | `id` is FIPS/postal code/ISO-3166. |
| `scale` | `{type: "sequential"\|"diverging"\|"categorical", domain?, midpoint?, bins?, unit?}` | |
| `legend` | `true` or `{title}` | |
| `labels` | `"none"\|"id"\|"value"` | |
| `geojson` | object | Subject to the limits above. |

Example: US choropleth, 2024-style margin map.

```json
{ "type": "map", "props": {
  "mode": "choropleth", "basemap": "none", "region": "us-states",
  "data": [
    { "id": "PA", "value": 1.7, "label": "Pennsylvania", "detail": "R +1.7" },
    { "id": "MI", "value": 1.4, "label": "Michigan",     "detail": "R +1.4" },
    { "id": "VA", "value": -5.8, "label": "Virginia",    "detail": "D +5.8" }
  ],
  "scale": { "type": "diverging", "domain": [-20, 20], "midpoint": 0, "bins": 7, "unit": "pts" },
  "legend": { "title": "Margin (R + / D -)" },
  "labels": "id", "height": 380 } }
```

Example: hex / tile cartogram, same data.

```json
{ "type": "map", "props": {
  "mode": "tiles-grid", "tiles": "us-hex", "basemap": "none",
  "data": [ { "id": "PA", "value": 1.7 }, { "id": "MI", "value": 1.4 }, { "id": "VA", "value": -5.8 } ],
  "scale": { "type": "diverging", "domain": [-20, 20], "midpoint": 0, "bins": 7 },
  "legend": true, "labels": "id" } }
```

`tiles` picks a bundled layout: `us-square`, `us-hex`, later `world-square`.

### chart

New `kind` values: `scatter`, `histogram`, `box`, `heatmap`, `treemap`, `sankey`, `funnel`, `waterfall`, `dumbbell`, `slope`. New shared props:

| Prop | Meaning |
|---|---|
| `orientation` | `vertical` or `horizontal` (today it is automatic) |
| `refs` | `[{axis: "x"\|"y", value, label}]` reference lines (solid hairline) |
| `notes` | `[{x, y, text}]` short annotations, text only |
| `facet` | field name; renders small multiples with shared scales |
| `labels` | `"ends"` (default), `"none"`, `"all"` (agent asks; guide discourages) |
| `scale` | same object as the map |
| `emphasis` | series key or x value to highlight, rest gray |

Rules the renderer enforces regardless of what the agent sends: one y axis, 5 series max (3 for scatter/bubble/facets, from the all-pairs limit), solid hairline grid, 2px surface gap between touching marks, bar thickness at most 24 px, 2px line, area wash 10%.

Example: dumbbell, poll vs result (margin in points, D+ positive).

```json
{ "type": "chart", "props": {
  "kind": "dumbbell", "orientation": "horizontal",
  "data": [
    { "state": "PA", "poll": -0.5, "result": 1.7 },
    { "state": "WI", "poll": 0.1,  "result": 0.9 },
    { "state": "MI", "poll": -0.8, "result": 1.4 },
    { "state": "AZ", "poll": 1.2,  "result": 5.5 }
  ],
  "x": "state",
  "series": [ { "key": "poll", "label": "Poll average" }, { "key": "result", "label": "Result" } ],
  "refs": [ { "axis": "y", "value": 0, "label": "Tie" } ],
  "sort": "gap", "unit": " pts" } }
```

Rendering: one row per state, a connector between the two dots (1 hue, two shades per the skill's "before to after" rule, or slots 1 and 2), the gap value labelled at the end, legend for two series, table toggle as today.

Example: stacked area.

```json
{ "type": "chart", "props": {
  "kind": "area", "stacked": true,
  "data": [
    { "week": "W1", "api": 120, "web": 80, "jobs": 30 },
    { "week": "W2", "api": 140, "web": 95, "jobs": 42 },
    { "week": "W3", "api": 133, "web": 110, "jobs": 38 }
  ],
  "x": "week",
  "series": [ { "key": "api", "label": "API" }, { "key": "web", "label": "Web" }, { "key": "jobs", "label": "Jobs" } ],
  "unit": " req" } }
```

This already works today. The change is rendering: drop the `monotone` curve for stacked (it can overshoot and misstate totals), use a 10% wash, and add `labels: "ends"` direct labels.

### Smaller additions

- `stat`: optional `spark: [numbers]` (12 points, de-emphasis colour, current point accented).
- `table`: column `format: "spark"` for a row array.
- `progress`/gauge: no new primitive; the guide points agents to `progress`.

### Rust validation and security

- Add each new prop to `ui-primitives.json` (enum for `kind`/`mode`/`scale.type`; numbers range-checked) and to `ui_library.rs`, in step with React as the file header says.
- Strings are rendered as text only. No format strings, no templates, no function-like values. `unit` stays a short suffix.
- Region ids are matched against the bundled table; unknown ids are listed back to the agent in an error, not silently dropped.

## 5. The dataviz skill

Found at `/private/tmp/claude-501/bundled-skills/2.1.316/30a17d072b6a738cc3c6c122ed5b2c0e/dataviz/` (`SKILL.md` was not in the bundled directory on this machine; `references/` and `scripts/validate_palette.js` were read). Files: `choosing-a-form.md`, `color-formula.md`, `marks-and-anatomy.md`, `anti-patterns.md`, `palette.md`, `components.md`, `interaction.md`.

yaah's chart.tsx already follows it in part (one y axis, fixed slots, legend for 2+, table twin, thin marks, no animation). Adopt the rest:

1. **Form choice before colour.** Add the "job to type" table to the agent guide: one number is a `stat`, a ratio against a limit is `progress`, trend is `line`, comparison is `bar`, before to after is `dumbbell`, ordered-scale share is a diverging stacked bar. No pie or donut; use ranked bars or a tall segmented bar.
2. **Four colour jobs.** Categorical (identity), ordinal (funnel stages, one hue), sequential (magnitude, one hue), diverging (polarity, blue to red with gray midpoint). Status colours (good/warning/serious/critical) only when the colour means a state, always with icon and label. Today's map `tone` already uses status colours, which is consistent.
3. **Palette validation.** Our 5 slots in `index.css` are the first five of the skill's eight and carry the same hex values. The skill's order is validated for adjacent pairs only. For scatter, bubble, choropleth and small multiples it caps at three categorical colours (`--pairs all`). The renderer should enforce that cap. If we add slots 6 to 8, run `node scripts/validate_palette.js "<hexes>" --mode light` and `--mode dark --surface "#1a1a19"`. If we add sequential and diverging ramps as CSS variables, check lightness monotonicity, not the categorical validator (it fails ramps by design). Our app surface colours differ from `#fcfcfb` / `#1a1a19`, so rerun with our actual surface.
4. **No dual axes.** Already in the primitive description; keep it, and name the alternatives (two charts, small multiples, index to 100).
5. **Direct labels, selectively.** Label the end, the extreme, or the emphasised series; never every point. Move labels outside a mark that is too small; never clip.
6. **Mark specs.** Bars at most 24 px thick with a 4 px rounded data end; lines 2 px; markers at least 8 px with a 2 px surface ring; area wash about 10%; solid hairline grid (we use dashed; change); 2 px surface gap between touching marks.
7. **Text never wears the data colour.** Labels use text tokens; only the mark carries the series colour.
8. **Emphasis form.** Add `emphasis`: one series in the accent, the rest gray. The skill calls it the most underused form.
9. **Table view for every chart and map.** For maps, a table of `id, value` behind a toggle.
10. **Tooltips never gate.** Region keyboard focus shows the same as hover.
11. **Hit targets** about 24 px; scatter uses nearest-point lookup.

Other installed skills relevant here: none for maps. `~/.claude/skills` has marketing, Supabase and similar skills; `artifact-design` and `artifact-diagramming` are about HTML artifacts, not this. `impeccable` covers general UI polish. A copy of Leaflet-based `map.tsx` exists in a `headroom` marketplace plugin's docs, not relevant to us.

## 6. Libraries to adopt

All versions were published at least two weeks before 4 November 2026 (cutoff 21 October 2026). Do not take d3-geo 3.1.2, which was published on 3 November 2026.

| Package | Version | Licence | gzip | Use |
|---|---|---|---|---|
| d3-geo | 3.1.1 | ISC | 14.6 KB | projections, path generator, great-circle arcs |
| topojson-client | 3.1.0 | ISC | 2.6 KB | decode TopoJSON to GeoJSON |
| d3-scale | 4.0.2 | ISC | 19.7 KB | sequential, diverging, threshold scales (shared with charts) |
| d3-shape | 3.2.0 | ISC | 8.6 KB | lines and areas for sparklines, slope, arcs |
| d3-hierarchy | 3.1.2 | ISC | 5.8 KB | treemap layout, if Recharts' is not enough |
| us-atlas | 3.0.1 | ISC (Census data) | 29.5 KB (states albers) | bundled US geometry |
| world-atlas | 2.0.2 | ISC (Natural Earth, public domain) | 38 KB (110m) | bundled world geometry |
| recharts | stay 3.8.0, optional bump to 3.10.1 | MIT | already shipped | cartesian charts |
| leaflet.markercluster | 1.5.3 | MIT | 9 KB | clusters in tile mode only |

Total new JS for the map core: about 35 KB gz (d3-geo + topojson + scale), plus about 30 KB of geodata loaded lazily. d3-scale-chromatic is not needed; we define our own ramps from the palette.

Skip: MapLibre GL, deck.gl, react-simple-maps, Vega/Vega-Lite, ECharts, Chart.js, Nivo, visx, Observable Plot.

Do not mix versions: install the data packages at exact versions and copy only the needed files into `app/src/assets/geo/` (or import with `?url`/JSON import), so builds are reproducible and no runtime fetch happens.

## 7. Security notes

- **No expressions, no eval.** Reject any prop whose value would be interpreted: format strings, formatter functions, Vega-style expressions, `{{ }}` beyond the existing `live` binding. Everything the renderer reads is a string rendered as text, a number clamped to a range, or an enum member.
- **CSP.** `script-src 'self'` stays; do not add `unsafe-eval`. All proposed code (d3-*, topojson-client, Recharts) is eval-free. Vega would need vega-interpreter and a custom linter; we avoid it.
- **Tiles.** Today OSM tiles load via `img-src https:`, which is broad: any https image from any host. The fixed URL in `map.tsx` is the real control. Keep it fixed. Consider narrowing `img-src` to specific tile hosts if nothing else needs `https:` images (the `image` primitive probably does; check before changing). OSM's tile usage policy requires a proper attribution (already shown) and discourages heavy or offline use; the outline-only default reduces tile traffic (policy text UNVERIFIED this session).
- **Geodata licences.** Natural Earth: public domain, no attribution required (terms page checked). US Census cartographic boundaries via us-atlas: ISC wrapper over federal data (UNVERIFIED that no other terms apply). Add a short "Data: US Census Bureau, Natural Earth" credit under legends anyway.
- **Agent GeoJSON.** Inline only, size and vertex caps, coordinate validation, no property used as HTML, no `href`. Parse in a try/catch; a bad shape shows an error card, not a crash.
- **Links.** `keepLinksOutside` stays on the map wrapper. No links in SVG.
- **Denial of service.** Cap rows (e.g. 2,000 per chart), series (5), markers (2,000), arcs (500), facets (12).
- **Accessibility.** SVG regions get `role="img"` groups with `aria-label` ("Pennsylvania, R +1.7"), a visible focus ring, and the table toggle.

## 8. Agent guide changes

In `app/src-tauri/agent-guide/yaah-ui.md` (and the `ui_catalog` descriptions in `ui-primitives.json`):

1. Replace "bar, line or area" with the kind list and one sentence per kind on when to use it.
2. Add a "Pick the form" table from the dataviz skill (section 5, point 1).
3. Add a map section: choose `choropleth` for a value per region, `tiles-grid` when small regions must be visible, `symbols` for a point value, `arcs` for flows, `markers` only for places on a street-level map. Default `basemap: "none"`.
4. State the colour rules: sequential unless the data has a meaningful midpoint; diverging only with a stated midpoint; at most 3 categorical colours on maps and scatter; at most 7 bins; always a legend.
5. State the limits (rows, series, GeoJSON size) so agents do not guess.
6. Show the four examples from section 4 in short form.
7. Say plainly: no formatter functions, no expressions, no URLs for data. Data goes inline or through `live` sources.
8. Add the election dashboard as an example component (`app/src-tauri/components/`): tabs, stat tiles, choropleth, hex cartogram, dumbbell.

## 9. Effort and phases

| Phase | Work | Size |
|---|---|---|
| 1 | `basemap: "none"` + d3-geo choropleth for `us-states` (bundled, lazy), `scale`, `legend`, table toggle, Rust schema, guide section. Fixes the election map. | M |
| 2 | Tile cartogram (`us-square`, `us-hex` layouts), `symbols`, `arcs`, `world` region. | M |
| 3 | Chart kinds that need custom SVG: dumbbell, slope, sparkline (stat and table), heatmap, waterfall, histogram. Add `refs`, `notes`, `emphasis`, `orientation`, direct end labels, mark specs from the skill. | M-L |
| 4 | Recharts-backed kinds: scatter, treemap, sankey, funnel, radar. `facet` small multiples. | M |
| 5 | Agent GeoJSON with limits and simplification, admin-1 per country, counties, clusters, heatmap. | L |
| 6 | Palette work: add `--scale-*` ramps, run validator for our real surfaces, optional slots 6 to 8. Can start with phase 1. | S |

Recommended order: 6 (ramps) with 1, then 3 (dumbbell and reference lines, because the user's dashboard needs both), then 2, 4, 5.

## 10. Sources

- yaah: `app/src/ui-primitives.json`, `app/src/components/ui-blocks/chart.tsx`, `app/src/components/ui-blocks/map.tsx`, `app/src-tauri/tauri.conf.json`, `app/package.json`, `app/src/index.css`.
- dataviz skill references (local), listed in section 5.
- Vega interpreter and CSP: https://vega.github.io/vega/usage/interpreter/
- Natural Earth terms: https://www.naturalearthdata.com/about/terms-of-use/
- us-atlas: https://github.com/topojson/us-atlas
- world-atlas: https://github.com/topojson/world-atlas (not fetched; licence from npm metadata and Natural Earth)
- json-render: https://json-render.dev
- A2UI: https://a2ui.org
- npm registry metadata for versions, licences and publish dates (queried 4 November 2026).
- ECharts: https://echarts.apache.org/en/option.html (page did not answer the formatter/CSP question; UNVERIFIED)
- Not checked: OSM tile usage policy (https://operations.osmfoundation.org/policies/tiles/), Claude artifacts, ChatGPT, MCP Apps, Observable docs, Recharts 3.8 sunburst support, Natural Earth admin-1 sizes.
