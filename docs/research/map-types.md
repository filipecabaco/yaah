# Map types for agent-built UI

4 November 2026. Research and design only, no code changed.

Trigger: the user called today's maps "still very weak" and pointed at the six map types in the D3 Graph Gallery. This builds on `maps-and-charts.md` (SVG with d3-geo + topojson-client, bundled atlases, Leaflet kept for street maps) and does not repeat it. The problems it must fix come from `docs/experiments/2026-11-04-map-gallery/`: labels only on hover, bright tiles in dark themes, no clustering, no route lines, outliers wrecking the fit, Expand squashing the map.

Sizes were measured on 4 November 2026 (esbuild `--minify`, gzip -9, named exports only; atlas files gzip -9 as shipped). Anything not checked against a primary source is marked UNVERIFIED.

## 1. What the gallery shows

Pages used (the gallery's example pages carry the code; the section pages only link to them):

- Index: https://d3-graph-gallery.com/index.html
- Map: https://d3-graph-gallery.com/backgroundmap.html , basic https://d3-graph-gallery.com/graph/backgroundmap_basic.html
- Choropleth: https://d3-graph-gallery.com/choropleth.html , https://d3-graph-gallery.com/graph/choropleth_basic.html , https://d3-graph-gallery.com/graph/choropleth_hover_effect.html
- Hexbin map: https://d3-graph-gallery.com/hexbinmap.html , https://d3-graph-gallery.com/graph/hexbinmap_geo_basic.html , https://d3-graph-gallery.com/graph/hexbinmap_geo_label.html
- Cartogram: https://d3-graph-gallery.com/cartogram.html
- Connection: https://d3-graph-gallery.com/connectionmap.html , https://d3-graph-gallery.com/graph/connectionmap_basic.html , https://d3-graph-gallery.com/graph/connectionmap_csv.html
- Bubble map: https://d3-graph-gallery.com/bubblemap.html , https://d3-graph-gallery.com/graph/bubblemap_tooltip.html , https://d3-graph-gallery.com/graph/bubblemap_template.html , https://d3-graph-gallery.com/graph/bubblemap_circle.html (circle features), legend: https://d3-graph-gallery.com/graph/bubblemap_legend.html

Not fetched: `bubblemap_circle` and `bubblemap_legend` returned 404; `bubblemap_basic` (an unrelated small-France example) was not used; the Leaflet, canvas, projection-change, single-country, CSV and button variants were read only as titles on the section pages. The legend and radius-scale facts below come from `bubblemap_template`, which contains both. The sub-example list for cartogram and the Bostock/blocks pages were not opened.

| Type | For | Data shape | d3 pieces | Geodata in the gallery |
|---|---|---|---|---|
| Map (background) | Context for other layers; show where something is | none, or a country filter | `geoPath`, `geoNaturalEarth1` (`scale(width/1.3/PI)`) or `geoMercator` | `world.geojson` (GeoJSON, ids and `properties.name`) |
| Choropleth | One value per region, compare regions | region id + number | `geoMercator` (scale 70, centre [0,20]), `scaleThreshold` + `schemeBlues[7]` | `world.geojson` + `world_population.csv`, join on feature `id`; missing = 0 |
| Hexbin map | Two meanings: a hexagon-tile layout of regions (equal area), or points binned into hexagons | GeoJSON of hexagons, or a list of coordinates | tile version: `geoPath` + `geoMercator` + `path.centroid` for labels; point version: `d3-hexbin` (named, no code on the page) | `us_states_hexgrid.geojson.json` (properties `iso3166_2`) |
| Cartogram | Region area proportional to a value | region geometry + number | `topogram` (Dougenik 1985, continuous). No code on the page | none given |
| Connection | Links between places | origin/destination pairs | `LineString` object with two coordinates passed to `geoPath().projection(p)`: great circle for free; `geoMercator` scale 85 | `world.geojson`, `data_connectionmap.csv` (`long1,lat1,long2,lat2`) |
| Bubble map | A value at a point | points with a number | `projection([lon,lat])` for cx/cy, `scaleSqrt` domain extent range [1,50], `scaleOrdinal` for colour | `world.geojson` + inline markers |

Practices worth copying:

- Bubbles: `scaleSqrt`, sorted descending by value before drawing so small bubbles end up on top (`bubblemap_template`); fill-opacity 0.4, stroke only on the biggest; a three-circle legend, circles aligned on a common baseline with dashed leader lines to labels, using the same scale.
- Choropleth: a threshold (binned) scale, seven blues, hover dims the others and outlines the hovered region (opacity .5 / 1, black stroke). The page has no legend and no tooltip.
- Connection: one `path` generator reused for land and for arcs; fill `none`, constant stroke.
- Hexbin tile map: labels at `path.centroid`, white text, 11 px.
- Bubble tooltip: a div with name, long, lat (the gallery builds it with `.html()`, which we must not copy; text only).

Gallery faults we should not copy: missing data silently becomes the lowest class (value 0); the bubble scale domain is the data extent, so the smallest bubble is not area-proportional to zero; the hexbin and cartogram pages ship no code; there is no keyboard access and no table anywhere; the tooltip is positioned with ad hoc offsets. One more observation: the gallery's "hexbin map" examples are really a hexagon tile cartogram (every state one hexagon). yaah should split these two ideas: tile layouts belong to `cartogram`, density belongs to `hexbin`.

## 2. One primitive, a `kind` prop

Keep one `map` primitive and widen `kind`: `markers` (today's behaviour, default so old calls work), `outline`, `choropleth`, `bubble`, `connection`, `hexbin`, `cartogram`.

Why not seven primitives: they share region, projection fit, scale, legend, labels, tooltip, table view and Expand sizing. One component owns those; per-kind props are validated in Rust by `kind` (the same plan as `chart`). Agents learn one name. Separate primitives would duplicate the guide and the schema entries. (The earlier doc used `mode`; use `kind` so `chart` and `map` read the same.)

Shared props (all kinds except `markers`, which keeps its own):

| Prop | Type, limit | Notes |
|---|---|---|
| `kind` | enum | |
| `region` | enum: `world`, `europe`, `us-states`, `europe-nuts2` (later `europe-nuts3`) | Names a bundled geometry. No URLs. `geojson` inline stays possible (limits in `maps-and-charts.md`). |
| `view` | optional `"auto"` or `[west,south,east,north]` | Default `auto`: fit to the data (section 6). |
| `height` | 160 to 900 px, default 360 | Ignored inside Expand, which fills the dialog. |
| `scale` | the existing `scale` shape | Colour scale for kinds that colour by value. |
| `legend` | `true` (default when the map encodes a value) or `{ title }` | |
| `labels` | `"auto"` (default), `"all"`, `"none"` | `"all"` is capped at 24 items. |
| `title` | text, 120 chars | Becomes the SVG `<title>` and the table caption. |

Colours are only ever theme tokens (`binColors()` in `scale.ts`, `--scale-seq-*`, `--scale-div-*`, `--chart-*`, `--muted-foreground`), never a string from the agent. The map surface, outlines and text use existing tokens (`--background`, `--border`, `--foreground`).

Names: an `id` field accepts what an agent naturally writes. See section 3.

## 3. Geodata

All geometry is bundled, loaded lazily with `import()` the first time a map of that `region` renders (one chunk per region, cached by the module system). Nothing is fetched at run time (CSP `connect-src` forbids it anyway). Build step: a script in `app/scripts/` (Elixir `.exs`, per the repo rule) reads the packages below, rewrites geometry ids to the canonical id, drops properties it does not need (keeps `name`), re-quantizes, and writes `app/src/assets/geo/<region>.topo.json` plus a generated `region-ids.json` that Rust also includes.

| Region | Source, exact version | Licence | Raw / gzip | Native id | Notes |
|---|---|---|---|---|---|
| `world` (default) | `world-atlas@2.0.2` `countries-110m.json` | ISC wrapper; data Natural Earth, public domain | 107,761 B / 38,423 B | ISO 3166-1 numeric string (`"242"`), `properties.name` | 177 geometries. Three have no id (N. Cyprus, Somaliland, Kosovo): assign `XKX` to Kosovo and drop or tag the other two. |
| `world` high detail | same package, `countries-50m.json` | same | 756,420 B / 230,118 B | same | Only when a map is zoomed to a country (a `view` bbox). Do not ship by default. `countries-10m` is 920 KB gz; skip. |
| `us-states` | `us-atlas@3.0.1` `states-albers-10m.json` | ISC wrapper; US Census Bureau boundaries | 82,031 B / 29,518 B | FIPS 2-digit string (`"01"`), `properties.name` | 51 geometries (50 states + DC), already Albers USA with Alaska and Hawaii inset. Skip the unprojected `states-10m.json` (36 KB gz). No Puerto Rico or territories. |
| `us-counties` | same package `counties-albers-10m.json` | same | 795,405 B / 255,868 B | FIPS 5-digit | Not in v1. Add only if an agent needs it. |
| `europe` (countries) | derived at build from `world-atlas@2.0.2` `countries-50m.json`, filtered to European ids | as `world` | not measured; expect roughly 60 KB gz after the filter (UNVERIFIED) | alpha-3 | 110m drops small states (Malta, Luxembourg, Monaco, Liechtenstein, Andorra), so use the 50m source for this one. Clip to about -25..45 E, 33..72 N so Russia and Turkey do not blow out the fit. |
| `europe-nuts2` | Eurostat GISCO `NUTS_RG_60M_2024_4326_LEVL_2.json` from `https://gisco-services.ec.europa.eu/distribution/v2/nuts/topojson/` | Copyright EuroGeographics and others, free re-use with conditions (UNVERIFIED: the licence page was not readable; read https://ec.europa.eu/eurostat/web/gisco/geodata/reference-data before bundling) | 175,844 B / 32,994 B | `NUTS_ID` (`"FR10"`), also `NAME_ENGL`, `CNTR_CODE` | Level 0 is 13 KB gz, level 1 20 KB gz, level 3 (about 1,500 regions, includes French départements) 93 KB gz. 2024 vintage. Overseas regions (Guyane, Réunion, Canaries, Azores, Madeira) must be dropped or inset at build. This is the only small, reliable, official European sub-national source found. |
| `fr-departements` | `gregoiredavid/france-geojson` `departements-version-simplifiee.geojson` | Licence Ouverte (Etalab), from IGN Admin Express 2018 | 569,299 B / 234,520 B as GeoJSON | INSEE code `"75"`, `nom` | Too big as GeoJSON; converting to quantized TopoJSON would shrink it a lot (not measured, UNVERIFIED). Not needed in v1: NUTS3 `FR*` already is départements. Skip unless asked. |

Id scheme and naming:

- Countries: canonical id is ISO 3166-1 alpha-3 in the data. Rust accepts alpha-2 (`PT`), alpha-3 (`PRT`), numeric, an English name, and a short list of aliases ("USA", "United States", "UK", "Czechia"/"Czech Republic", "Türkiye"/"Turkey"), case-insensitive, and rewrites it to the canonical id before the tree reaches React. Real ISO codes for the three odd geometries are not defined; use `XKX` for Kosovo (user-assigned, common convention).
- US states: canonical id is the postal code (`PA`). Accept FIPS (`"42"`, `42`), postal code, English name ("Pennsylvania"), "D.C."/"District of Columbia".
- NUTS: canonical id is `NUTS_ID`; accept English name only when unique, otherwise error.
- Validation (Rust): the generated `region-ids.json` lists `{id, name, alpha2?, alpha3?, fips?, aliases[]}` per region set. An unknown id returns an error naming the field, the row, and up to three nearest names (edit distance), e.g. `data[4].id "Pensilvania" is not in us-states, did you mean "Pennsylvania" (PA)?`. Duplicate ids after normalization are an error. Rows for regions not in the set are an error, not silently dropped, so the agent fixes the typo.
- The same Rust check validates `points` coordinates (finite, lon -180..180, lat -90..90) and caps row counts.

Bundle total for the first release: world 38 KB + us-states 30 KB + europe ~60 KB gz, each loaded on demand. Everything else waits.

## 4. Libraries

Pinned exactly. `npm view <pkg> time` on 4 November 2026 shows that **d3-geo 3.1.2, d3-scale 4.0.3, d3-array 3.2.5, d3-interpolate 3.0.2, d3-force 3.0.1 and d3-delaunay 6.0.5/6.0.6 were all published on 3 November 2026**. None may be taken (less than two weeks old). The lockfile already holds d3-geo 3.1.1 and d3-array 3.2.4 (transitive), and d3-scale 4.0.2 is pinned in `package.json`. Because d3-geo declares `"d3-array": "2.5.0 - 3"`, a fresh resolve would pick 3.2.5: pin `d3-array` to 3.2.4 with a pnpm override, and keep the lockfile.

| Package | Pin | Published | Licence | Size (gzip, named imports used) | Use |
|---|---|---|---|---|---|
| d3-geo | **3.1.1** | 12 Mar 2024 | ISC | 10.2 KB (`geoPath`, `geoMercator`, `geoNaturalEarth1`, `geoAlbersUsa`, `geoConicConformal`, `geoInterpolate`, `geoCentroid`, `geoDistance`) | Projection, path, arcs, `fitExtent` |
| topojson-client | 3.1.0 | 6 Nov 2019 | ISC | 1.3 KB (`feature`, `mesh`) | Decode atlases; `mesh` for borders |
| d3-hexbin | 0.2.2 | 28 Mar 2017 | BSD-3-Clause | 0.7 KB | Hexbin kind. Old but tiny and pure; `@types/d3-hexbin` 0.2.5 exists. If it ever bites, the binning is about 40 lines to own. |
| d3-scale | 4.0.2 (already) | 24 Sep 2021 | ISC | already shipped | `scaleSqrt` for bubbles, `scaleLinear` for arc width |
| d3-force | **3.0.0** | 5 Jun 2021 | ISC | 4.6 KB (`forceSimulation`, `forceCollide`, `forceX`, `forceY`) | Dorling cartogram only, Phase 3. Not 3.0.1. |
| us-atlas | 3.0.1 | 19 Apr 2023 | ISC | dev dependency; files above | Build input only |
| world-atlas | 2.0.2 | 5 Sep 2019 | ISC | dev dependency; files above | Build input only |
| leaflet.markercluster | 1.5.3 | 18 Oct 2021 | MIT | 9 KB (from the earlier doc, not re-measured) | Clusters on the tile map |

d3-geo ships ES modules and uses no `eval` or `Function`, so it is fine under `script-src 'self'`; confirm with the existing CSP test when wiring it (UNVERIFIED for d3-geo specifically, I did not grep the build). The atlases and NUTS file go in as dev-time inputs and only the derived `.topo.json` ships, so their npm version only matters for reproducing the build. Prefer a `devDependencies` pin plus a committed derived file.

## 5. Per-kind design

### 5.1 outline (the plain map)

For: a base with some regions highlighted and markers on top, no data encoding. Works offline, no tiles, in every theme.

| Prop | Type, limit |
|---|---|
| `highlight` | `[{ id, label?, detail?, tone? }]`, max 100. `tone`: `default`, `success`, `warning`, `danger` (same enum as markers today). |
| `points` | `[{ id?, lon, lat, label, detail?, tone? }]`, max 200 |
| `borders` | `"countries"` (default) or `"none"` |

```json
{ "type": "map", "props": {
  "kind": "outline", "region": "europe", "title": "Edge locations",
  "highlight": [ { "id": "PT", "tone": "success" }, { "id": "DE", "tone": "success" }, { "id": "PL", "tone": "warning", "detail": "degraded" } ],
  "points": [ { "lon": -9.14, "lat": 38.72, "label": "Lisbon" }, { "lon": 13.4, "lat": 52.52, "label": "Berlin" } ],
  "labels": "all" } }
```

Rendering: land fill `--muted`, hairline `--border`, highlighted regions use the tone's token with a pattern or marker, never a colour change alone (the label and the table say the status). No legend unless tones are used; then a short key (tone name, count).

### 5.2 choropleth

For: one value per region, ranking and comparing regions (European election results by country, US states). Prefer it over bubble when regions are comparable in size; prefer a tile `cartogram` (section 5.5) when small regions must be seen.

| Prop | Type, limit |
|---|---|
| `data` | `[{ id, value, label?, detail? }]`, max 3,000 rows (counties later); `value` finite number, `null` allowed to say "no data" |
| `scale` | shared `scale`; default sequential, 5 bins; diverging requires `midpoint` |
| `noDataLabel` | text, default "No data" |

```json
{ "type": "map", "props": {
  "kind": "choropleth", "region": "us-states", "title": "2024 margin by state",
  "data": [
    { "id": "PA", "value": 1.7,  "detail": "R +1.7" },
    { "id": "MI", "value": 1.4,  "detail": "R +1.4" },
    { "id": "VA", "value": -5.8, "detail": "D +5.8" },
    { "id": "WY", "value": 46.1, "detail": "R +46.1" } ],
  "scale": { "type": "diverging", "domain": [-20, 20], "midpoint": 0, "bins": 7, "unit": "pts" },
  "legend": { "title": "Margin (R + / D -)" }, "labels": "auto" } }
```

```json
{ "type": "map", "props": {
  "kind": "choropleth", "region": "europe", "title": "Turnout in the 2024 European election",
  "data": [ { "id": "BE", "value": 89.0 }, { "id": "PT", "value": 36.5 }, { "id": "SK", "value": 34.4 }, { "id": "MT", "value": null } ],
  "scale": { "type": "sequential", "bins": 5, "unit": "%" }, "legend": true } }
```

(The numbers in the examples are illustrative, not checked.)

- Colour: `binColors(scale)` per region by bin; hover and focus add a 2 px `--foreground` outline and raise the region (re-append last in the SVG, since SVG has no z-index). The gallery's dim-the-others effect is optional; skip it, because it lowers contrast for the focused value.
- Missing data: regions in the geometry with no row, or `null`, get a diagonal hatch pattern in `--border` on the surface plus a "No data" legend swatch. Never the lowest class (the gallery's mistake).
- Outliers: values are binned between the scale domain ends and clamped, so one extreme value cannot wash out the rest; the end bins are labelled "< lo" and "> hi". When the agent gives no `domain`, use Tukey fences (Q1 - 1.5 IQR, Q3 + 1.5 IQR) for 8 or more values, else the min/max, and say so in the legend footer ("axis clipped at ..."). This is a change to `domainOf`; the existing function takes the extent.
- Labels: `auto` prints the region id (or the value, if `labels: "value"` is added later) where the projected bounding box fits the text (pure function on path bounds and a character-width estimate), so big regions get labels and small ones rely on hover and the table; the text colour flips to the readable side of the bin colour. `all` prints every label at least 9 px, capped at 24.
- Legend: a horizontal strip of bins below the map (swatches with thresholds), the title, the no-data swatch. For diverging, the midpoint is marked.

### 5.3 bubble

For: a value at a place (store revenue by city, weather stations). Prefer it over choropleth when the value belongs to a point or when region sizes would mislead (a big empty region shouldn't dominate).

| Prop | Type, limit |
|---|---|
| `points` | `[{ id?, lon, lat, value, label, detail?, shade? }]`, max 500; `value >= 0` |
| `maxRadius` | px, 6 to 48, default scales with the map (about 1/12 of the short side) |
| `scale` | optional; only if points carry `shade` (a second variable). Absent: bubbles use `--chart-1` |
| `unit` | text for the size legend |

```json
{ "type": "map", "props": {
  "kind": "bubble", "region": "europe", "title": "Store revenue by city",
  "points": [
    { "lon": -9.14, "lat": 38.72, "label": "Lisbon", "value": 4.2 },
    { "lon": 2.35,  "lat": 48.86, "label": "Paris",  "value": 7.9 },
    { "lon": 13.4,  "lat": 52.52, "label": "Berlin", "value": 3.1 } ],
  "unit": "M EUR", "labels": "auto" } }
```

- Radius: `scaleSqrt().domain([0, max]).range([0, maxRadius])`, so area is proportional to value and zero is zero. A floor of 2 px keeps a positive value visible. The gallery's extent domain with range [1, 50] is not proportional. Negative values are not drawn; the legend footer says how many.
- Order: draw sorted by value, largest first, so small bubbles stay on top and hoverable (the gallery does this).
- Overlap: fill at 0.55 opacity, 1 px surface-coloured stroke; no collision simulation in v1. For heavy overlap (the 200-station case), use `hexbin`, or recommend it in the agent guide above 150 points. A Dorling-style relaxation is possible later with d3-force, but it moves points off their places, so only in the cartogram kind.
- Labels: top 5 by value get a label (right of the bubble, greedy collision check against placed labels, flipped to the left at the edge), or all when 12 or fewer points; the rest on hover or focus. Route numbers and values for small counts are visible at once.
- Legend: nested circles for three nice values (for example 1, 5, 10 M EUR) sharing a baseline, with the unit, drawn with the same scale; plus a colour legend if `shade` is used. The gallery's three-circle legend is the model.
- Colour never carries the size: size is the encoding; `shade` is an optional second variable, always in the legend and in the table.

### 5.4 connection

For: flows and routes between places (flights, shipping between hubs). Prefer it over a table when geography matters and there are 200 or fewer links.

| Prop | Type, limit |
|---|---|
| `hubs` | `[{ id, label, lon, lat }]`, max 100 |
| `links` | `[{ from, to, value?, label?, detail? }]`, max 200; `from` and `to` are hub ids |
| `directed` | boolean, default false |
| `width` | `"value"` (stroke by value) or `"fixed"`, default `value` when values exist |

```json
{ "type": "map", "props": {
  "kind": "connection", "region": "world", "title": "Daily flights from hubs",
  "hubs": [ { "id": "LIS", "label": "Lisbon", "lon": -9.14, "lat": 38.77 }, { "id": "GRU", "label": "Sao Paulo", "lon": -46.47, "lat": -23.43 }, { "id": "JFK", "label": "New York", "lon": -73.78, "lat": 40.64 } ],
  "links": [ { "from": "LIS", "to": "GRU", "value": 6 }, { "from": "LIS", "to": "JFK", "value": 9 }, { "from": "JFK", "to": "GRU", "value": 3 } ],
  "directed": true, "labels": "auto" } }
```

- Arcs: pass `{ type: "LineString", coordinates: [a, b] }` to `geoPath(projection)`. d3-geo follows the great circle with adaptive resampling, so the shape is right in any projection, and it cuts at the antimeridian. Use `geoNaturalEarth1` for `world` (no polar blow-up; Mercator's y diverges at the poles, so clamp to +-85 if Mercator is ever used). For label positions use `geoInterpolate(a, b)(0.5)` projected: a pure function, no DOM measuring.
- Thickness: `scaleLinear` (or sqrt) from value to 1 to 8 px stroke; drawn thickest first so thin arcs stay on top. Opacity 0.7 so crossings read.
- Direction: `directed` adds an arrowhead (SVG `<marker>` with `markerUnits="strokeWidth"`, size follows the stroke) and a small dot at the origin. A colour gradient along the arc would need `gradientUnits="userSpaceOnUse"` per arc (an object-bounding-box gradient fails on a perfectly horizontal path); skip it, since colour alone can't carry direction.
- Many-to-one: hubs are declared once and referenced by id, so a hub that receives 60 links costs 60 short rows. Hub dots are sized by total degree or value, labelled when the hub count is 12 or fewer. Past 40 links, labels apply to hubs only; link values show on hover and in the table.
- Limits: 200 links; no edge bundling (the gallery links to it, but it needs layout code and hurts readability for non-experts). Self-links and unknown hub ids are validation errors. Over 200 links, the agent should aggregate or use the table.
- Legend: stroke width key (three nice values with the unit), and the arrow meaning when `directed`.

### 5.5 cartogram

For: showing every region at equal weight (small ones visible) or sized by value. The gallery's example is a contiguous, Gastner-Newman style distortion (topogram, Dougenik). That needs an iterative mesh deformation library, is unmaintained, gives shapes people misread, and needs geometry-specific tuning: do not ship it.

Options without running agent code:

| Option | Cost | Fit |
|---|---|---|
| Tile grid (US states, Europe countries), bundled layouts | A table `{id, col, row}` per set, authored once; squares or hexes in plain SVG, no geodata dependency | Best for elections: every state one tile, no overlap, always readable, labels fit inside. Fully deterministic and cheap. |
| Dorling (circles sized by value, `d3-force` collide) | d3-force 3.0.0, 4.6 KB gz; run 200 to 300 ticks synchronously from projected centroids; 250 nodes should take a few ms to tens of ms (UNVERIFIED). Deterministic because d3-force uses a seeded generator (UNVERIFIED). A worker is not needed at this size | Good for "area = value" on a recognisable layout. Looks like a bubble map that avoids overlap, but positions drift from truth. |
| Non-contiguous (each region scaled about its centroid by sqrt(value/ref)) | Trivial: `geoPath` plus an SVG transform | Keeps real shapes; large values overlap neighbours, gaps open elsewhere. Fine for small sets. |
| Contiguous (Dougenik, Gastner-Newman) | A library or about 300 lines of mesh code, plus tuning | Skip. |

Recommendation: **tile grid first** as `kind: "cartogram"`, `layout: "tile-square" | "tile-hex"`, then Dorling as `layout: "dorling"` if asked for. Skip the other two.

| Prop | Type |
|---|---|
| `layout` | `"tile-square"` (default), `"tile-hex"`, `"dorling"` |
| `region` | `us-states`, `europe` (a tile layout exists per region) |
| `data`, `scale`, `legend`, `labels` | as choropleth; the `tile` layouts reuse the choropleth renderer with tile geometry |
| `sizeBy` | Dorling only: `"value"` (default) |

```json
{ "type": "map", "props": {
  "kind": "cartogram", "layout": "tile-square", "region": "us-states", "title": "2024 margin, one tile per state",
  "data": [ { "id": "PA", "value": 1.7 }, { "id": "VA", "value": -5.8 }, { "id": "WY", "value": 46.1 } ],
  "scale": { "type": "diverging", "domain": [-20, 20], "midpoint": 0, "bins": 7, "unit": "pts" },
  "labels": "all", "legend": true } }
```

Tile grid sources: author our own `{id, col, row}` tables (US 51 tiles, European countries about 45) and check them in review for neighbour fidelity; no licence issue. The gallery's `us_states_hexgrid.geojson.json` exists but its licence was not checked, so do not use it (UNVERIFIED). Because each tile is a unit, labels always fit and `labels: "all"` is allowed up to 60.

### 5.6 hexbin (density)

For: many raw points where counts per area matter (200 weather stations, incident locations). Prefer it over bubble above about 150 points or when points overlap.

| Prop | Type, limit |
|---|---|
| `points` | `[{ lon, lat, weight? }]`, max 5,000 |
| `radius` | hexagon radius in px, 8 to 40, default 16 |
| `aggregate` | `"count"` (default), `"sum"`, `"mean"` of `weight` |
| `region` | optional underlay |
| `scale` | sequential, default 5 bins |

```json
{ "type": "map", "props": {
  "kind": "hexbin", "region": "europe", "title": "Weather stations per cell",
  "points": [ { "lon": -9.1, "lat": 38.7 }, { "lon": -8.6, "lat": 41.1 }, { "lon": 2.3, "lat": 48.8 } ],
  "radius": 14, "scale": { "type": "sequential", "bins": 5, "unit": "stations" }, "legend": true } }
```

- Data choice: **raw points binned in the client**. Pre-binned data would force the agent to know the grid, and a grid that depends on the pixel size cannot be bundled. Cap at 5,000 points (about 125 KB of JSON); beyond that the agent must aggregate. Project points first, then `hexbin().x().y().radius(r).extent(...)` (d3-hexbin works in projected pixels), so bin geometry is regular on screen. The cost: bins change on Expand (resize), so the table's cell values change with size; say so in the table caption, and keep rebin on resize debounced.
- Drawing: `hexbin.hexagon(radius - 0.5)`, fill via the bin's colour, one `<path>` per bin (hundreds, fine). Empty cells are not drawn. Optional `mean`/`sum` of `weight`.
- Labels: off by default (hexes are small); `all` shows the count when radius is 16 px or more; hover or focus gives the count and cell centre.
- Outliers: binned scale with clamped ends, as for the choropleth. A few isolated points are still one hex of count 1: visible, in the lowest class.
- Legend: bin strip with the unit and "n points in m cells".

## 6. Cross-cutting behaviour

### Labels and tooltips

- Always visible when there are 12 or fewer labelled items (route numbers, values, tile ids). Selective above that: the largest by value, the biggest regions whose box fits, never overlapping a placed label. Everything else on hover and keyboard focus.
- Tooltip: one absolutely positioned div, text only (`textContent`), clamped inside the map box, shown on hover, on focus and on tap. Same content as the table row: name, value with unit, `detail`.
- Font: 11 px, fixed regardless of zoom or Expand size; bubbles and strokes do not scale their text.

### Accessibility

- A Map/Table toggle like the one on `chart`. The table lists every region or point with name, value, bin label, detail (and from, to, value for connections; cell centre and count for hexbin, top 50 rows). It is the accessible equivalent and the way to read small regions.
- Focus: the SVG is one tab stop (roving tabindex). Arrow keys move to the nearest neighbour region or point; Enter or Space pins the tooltip; Escape clears. Each focusable has `role="img"` and an `aria-label` like "Pennsylvania, R +1.7, margin bin 3 of 7". The SVG carries `<title>` and `<desc>` from `title` and a generated summary (range, count of regions without data).
- Meaning never in colour alone: values are always in the tooltip, the table and, for tiles and large regions, the label; missing data is hatched; tones in `outline` have text in the label; direction is an arrowhead; size, not colour, carries bubble value. Bin colours come from the tested ramps in `scale.ts`, and adjacent bins keep the 3:1 rule for marks (`binColors(scale, true)` for small marks like hex fills and bubble dots).
- Reduced motion: no transitions on hover; no animated draw-in.
- Touch: tap shows the tooltip; no hover-only information.

### Empty, missing and outlier data

- No rows: the map draws the base and a centred "No data to show" message plus the legend, never a blank box.
- All values equal: a single class, legend shows one swatch.
- Missing: choropleth and tiles hatch; bubble, connection and hexbin simply omit it.
- Outliers: scale domain clamps (above); in `bubble` the max radius caps the largest, and a single huge value shrinks the rest, so the legend shows true values and the agent guide suggests a log or "other" row.
- Geographic outliers (the Madeira and Azores problem): fit to the core. `view: "auto"` fits to the extent of the data after dropping points outside the 2nd to 98th percentile of longitude and latitude when there are 20 or more points, and shows a chip "3 points outside view" that expands the view or lists them in the table; `view: [w,s,e,n]` overrides. Applies to `markers` and the new point kinds.
- Projection fit is a pure function: `fitProjection(kind, region, bounds, width, height)` returns a projection by calling `projection.fitExtent([[pad, pad], [w - pad, h - pad]], geoObject)` (or `fitSize`). Padding 8 px.

### Expand

The map reads its box size with a `ResizeObserver` (on the wrapper), not a fixed `height` prop. In the inline card the box is `height` px; in Expand it is 100% of the dialog body. On size change, recompute the projection fit and re-render the SVG at the measured pixel size (do not scale a `viewBox`, so text and strokes stay the same size). For Leaflet, call `invalidateSize()` then refit to the markers; that is the fix for today's 252 px squashed map. Hexbin rebins on resize; connection and bubble recompute radii from the new `maxRadius`.

## 7. Leaflet and tiles

Keep Leaflet, yes, for `kind: "markers"` only, which stays the street-level mode: use it when the question is "where on the streets" (a delivery round, a city's stations). Region kinds (outline, choropleth, bubble, connection, hexbin, cartogram) never load Leaflet or tiles, so they work offline and are themed by tokens.

Fixes on the tile map:

- Routes: add `lines` (`[{ points: [id, id, ...] | [[lat,lng],...], label?, tone? }]`) drawn as polylines, with numbered stops. For a delivery round, `route: true` could connect the markers in array order. Straight lines on the map are fine at city scale; great circles only matter for the connection kind.
- Clusters: leaflet.markercluster 1.5.3 (MIT, 9 KB gz), on when markers exceed 40; cluster bubbles show the count and the worst tone. Dense 200-station maps move to `hexbin` or `bubble` guidance in the agent guide.
- Fit: the same percentile fit and "N outside view" chip as above.
- Dark tiles: two ways.
  - **CSS filter (recommended):** on the tile pane when the active theme is dark, `filter: invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.9)` (tune in a screenshot pass). No new host, works under the current CSP (`img-src https:`), follows theme switches instantly, and keeps OpenStreetMap as the only tile server. Cost: muted colours; markers and labels live in other panes, so they are not inverted.
  - A dark tile provider (for example CARTO dark_all raster tiles): allowed by `img-src https:`, but it sends the user's map positions to a second third party, needs its own attribution, and its terms were not checked (UNVERIFIED). Not for now.
- OSM tile policy limits heavy use and requires attribution and an identifying referer for apps (UNVERIFIED, from memory; check https://operations.osmfoundation.org/policies/tiles/ before a release that raises usage).

## 8. Summary of the six types

| gallery type | yaah `kind` | Data (props) | Scale | Max | Labels | Table | Phase |
|---|---|---|---|---|---|---|---|
| Map | `outline` | `highlight`, `points` | tone tokens | 100 regions, 200 points | all up to 12 | yes | 1 |
| Choropleth | `choropleth` | `data[{id,value}]` | shared `scale` | 3,000 rows | auto by fit | yes | 1 |
| Bubble map | `bubble` | `points[{lon,lat,value}]` | sqrt radius; optional `scale` for `shade` | 500 | top 5 or all up to 12 | yes | 1 |
| Connection | `connection` | `hubs`, `links` | width by value | 100 hubs, 200 links | hubs, link on hover | yes | 2 |
| Hexbin map | `hexbin` | `points` | sequential, binned | 5,000 points | count when radius >= 16 | yes | 2 |
| Cartogram | `cartogram` (`tile-square`, `tile-hex`, `dorling`) | as choropleth | shared `scale` | 60 tiles | all | yes | 3 |

## 9. Implementation plan

New code follows the existing layout: renderer in `app/src/components/ui-blocks/map/`, schema in `ui-primitives.json`, Rust validation beside the other primitives, mock cards in `app/src/dev/mock/map-gallery.ts`. The existing `scale.ts` is used as is, apart from the Tukey-fence domain change.

**Phase 1: about 5 to 7 working days.** Build and data: the `.exs` build script, `region-ids.json`, world, us-states and europe TopoJSON, lazy loader, Rust id normalizer and validator with near-match errors (about 1.5 days). Shared map shell: `ResizeObserver` sizing, `fitProjection`, region path drawing, tooltip, roving focus, table toggle, legend (about 2 days). Kinds: `outline`, `choropleth`, `bubble` (about 2 days). Schema, agent guide, mock cards for each, and a re-shoot of the gallery in light, dark and Expand (about 1 day). Includes fixing the Leaflet Expand resize and the dark-tile filter (half a day, small).

**Phase 2: about 4 days.** `connection` (hub/link validation, arc paths, widths, arrowheads, midpoint labels): 2 days. `hexbin` (projection, binning, bin scale, legend): 1.5 days. Markers-kind routes, clusters and percentile fit: 1 day (can move into Phase 1 if the dark and Expand fixes are not enough).

**Phase 3: about 3 to 4 days.** Tile layouts for US states and Europe, hex and square, and review of neighbour fidelity (1.5 days). Dorling (1 day) only if asked. NUTS2 region (about 1 day: overseas drop, ids, names, licence read).

Tests (vitest, pure functions first; the repo already tests `scale.ts` and `map-gallery`):

- Fit: `fitProjection` returns a projection whose bounds of the target geometry sit inside the padded box, for several aspect ratios (360x200, 900x500, 252x252), and the same geometry in the Expand size.
- Scale: bin index for each value including exact thresholds, clamped outliers, Tukey fences, the diverging midpoint, `null` as no data.
- Bubble: `scaleSqrt` area proportion (area(2v) is 2 x area(v)), zero is zero, order largest first, negative values are dropped and counted, legend values are "nice".
- Binning: hexbin on a fixed point set gives the expected counts and bin count; sum and mean with weights; points outside the extent are ignored.
- Arcs: great-circle midpoint equals `geoInterpolate(a,b)(0.5)`; an arc across the antimeridian splits into two sub-paths; a thickness scale min/max.
- Labels: the fit-or-hide function with a fixed text width, greedy placement is non-overlapping.
- Ids: Rust tests for alpha-2, alpha-3, numeric, FIPS, name, alias and typo errors per region set; duplicates; unknown region.
- Render tests (jsdom, as in `map-gallery.test.tsx`): focusable regions have names; the table has one row per region; no network request for region kinds; Leaflet is not imported for them.
- A strict-CSP smoke test in the packaged build that renders one map of each kind (no `eval`).
- Screenshot pass via vitro for the dark and Tokyo Night themes and Expand, saved under `docs/experiments/<date>-<topic>/` with a README, as before.

## 10. Open items

- Read the GISCO and OSM terms before bundling NUTS2 or raising tile traffic.
- Decide the Europe country filter (EU only, or Europe including Russia and Turkey) and the territories policy (inset vs. drop).
- Check d3-geo 3.1.1 for any `Function` or `eval` use with the strict CSP.
- Re-measure the `europe` country TopoJSON after the filter and quantization.
- Confirm d3-force's seeded random and the Dorling timing on a 250-node set before committing to it.
