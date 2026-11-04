# d3 core, region maps and flow graphs (2026-11-04)

The first build of the staged move in `docs/research/d3-everywhere.md` and phase 1 of `docs/research/map-types.md`: the shared figure core (`app/src/components/ui-blocks/viz/`), the dumbbell moved onto it, `map` kinds `outline`, `choropleth` and `bubble` (SVG over d3-geo 3.1.1 and bundled atlases), the new `flow` primitive (`sankey` on d3-sankey 0.12.3, `network` on d3-force 3.0.0), and two fixes to the Leaflet street map. Bar, line and area stay on Recharts until the gate in `d3-everywhere.md`.

Shot at 1440x900 with `pnpm exec vite --port 1463 --strictPort`, quick chat, driven with vitro. Prompts: "map types" (`app/src/dev/mock/map-types.ts`), "flow graphs" (`flow-graphs.ts`), "election dashboard" and "map gallery" (`chats.ts`, `map-gallery.ts`). Themes switched through `src/lib/theme.ts` (yaah light, yaah dark, Tokyo Night). All data is made up or rounded for illustration.

| File | Shows |
|---|---|
| `01-light-world-choropleth.jpg` | World choropleth, 44 countries by id, alpha-2 and name; sequential 5 classes; unset domain fenced (Tukey) and rounded to 40–100 with the low end open ("< 52%") and the footer saying so; countries without a row hatched, Antarctica plain land; names where they fit |
| `02-light-us-election-choropleth.jpg` | US states by 2024 margin, diverging 7 classes over [-30, 30]; D.C. (-83.8) clamped into the open end class; postal codes on every state, text on the readable side of each fill |
| `03-light-europe-bubbles.jpg` | 24 stores as bubbles over the Europe set: area proportional to revenue over [0, max], largest drawn first, top 5 labelled, nested size legend; the Azores store left out of the fit (percentile and fence) but still in the wide box |
| `04-light-outline-focus-tooltip.jpg` | Outline with highlighted countries by tone (also said in words and in the key with counts), sites as dots; keyboard focus on Italy with its tooltip and focus outline |
| `05-light-us-table.jpg` | The Table view of the US map: every row by value, with its class |
| `06-dark-world-choropleth.jpg`, `07-dark-us-choropleth-focus.jpg`, `08-dark-europe-bubbles.jpg` | yaah dark: ramps and land, coast and hatch tokens follow the theme; focus tooltip on Pennsylvania |
| `09-tokyo-night-us-choropleth.jpg`, `10-tokyo-night-outline.jpg` | Tokyo Night: the theme's own chart and ramp colours |
| `11-tokyo-night-expand-us.jpg` | The US map in the Expand dialog: fills it (1326x588) and refits at the measured size; text and strokes keep their size |
| `12-tokyo-night-ci-sankey.jpg` | CI runs as a sankey: 8 stages, bands by value, links to Passed and Failed in their tone, labels placed beside each node without overlap |
| `13-tokyo-night-service-network-focus.jpg` | Service network: 15 nodes in 3 tier groups (categorical slots, with a legend), sized by weight, lines by request rate; focus on `api` |
| `14-tokyo-night-package-graph-180.jpg` | 180-package network laid out in the worker; the 12 most connected labelled |
| `15-light-sankey-link-focus.jpg` | Enter on a node steps onto its links: Lint → Unit tests highlighted with its tooltip |
| `16-light-service-network.jpg`, `17-dark-ci-sankey.jpg` | The flows in yaah light and dark |
| `18-dark-election-dashboard-map.jpg`, `19-light-election-dashboard-map.jpg`, `20-tokyo-night-election-dashboard-focus.jpg` | The election dashboard's Map tab, now a US choropleth on the dumbbell's diverging scale; the 36 states not in the set hatched as "Not in this set"; focus on Louisiana |
| `21-dark-leaflet-city-tiles-inverted.jpg`, `22-dark-leaflet-continent-tiles-inverted.jpg` | Fix for `2026-11-04-map-gallery/09-dark-city.jpg` and `10-dark-continent.jpg`: in a dark theme the OSM tile pane is inverted by a CSS filter (`invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.88) saturate(0.7)`), markers and attribution untouched, no second tile host |
| `23-tokyo-night-leaflet-expand-continent.jpg` | Fix for `2026-11-04-map-gallery/14-expand-dialog-continent.jpg`: the map was squashed to 252 px; now it is never shorter than its inline height (398 px here, the table below shares the rest) and refits once the size has held for a frame |
| `24-tokyo-night-narrow-pane-us.jpg` | The US map in a ~575 px split pane (two ⌘D), refitted to 502 px |

## Checked on the way

- Release CSP: a production build with the browser mock, served by `app/scripts/csp-serve.exs` (the policy Tauri sends), ran "map types" and "flow graphs", including the 180-node network in its module worker: no CSP reports, no errors. The built chunks were grepped for `eval(`, `new Function` and `Function(`: none in any new chunk (the four that match, Recharts' chart chunk and three Mermaid ones, match on the base build too).
- Geodata chunks (`world.topo`, `europe.topo`, `us-states.topo`) are imported only from `geo-map`, which loads on first use and never pulls the Leaflet chunk.

## Not changed, seen on the way

- A choropleth with few rows on a large set (the election tab's 14 of 51 states) hatches everything else; correct per `map-types.md`, but busy. A `noDataLabel` like "Not in this set" helps; a future option could draw missing regions as plain land instead.
- In a wide inline card the Europe frame shows much of Russia (the box is height-bound).
- One faint vertical tile seam is visible at about 100°W in the inverted dark tiles at zoom 3 (23).
