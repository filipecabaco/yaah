# Maps phase 2 (2026-11-04)

Follows `2026-11-04-d3-maps-flow/` and its "left for later" list, and phase 2 of `docs/research/map-types.md`: fixes to the choropleth, bubble and label rules seen in that set's screenshots, two new `map` kinds (`connection`, `hexbin`), the 1:50m world for zoomed views, and routes and clusters on the Leaflet street map.

Shot at 1440x900 with `pnpm exec vite --port 1477 --strictPort` (browser mock), quick chat, driven with vitro. Prompts: "show me the map types" (`app/src/dev/mock/map-types.ts`, now ten cards) and "show the election dashboard" (`chats.ts`, Map tab). Themes switched through `src/lib/theme.ts` (yaah light, yaah dark, Tokyo Night). All data is made up or rounded for illustration.

| File | Shows |
|---|---|
| `01-light-world-choropleth-land-labels.jpg` | World choropleth, 44 of 177 countries with a row: the other 133 are plain land ("Not in the data" in the legend), not hatched; only North Korea's explicit `null` is hatched ("No data"). Labels sit at each country's pole of inaccessibility and only where the whole label lies inside it; a big country whose name won't fit takes its code (US, CN, IN). "Mexico" no longer lands on the Gulf coast (it is skipped: at this size it doesn't fit inside). The clipped-scale note names only the side that was cut |
| `02-light-europe-bubbles-rings-labels.jpg` | Store revenue: largest drawn first so small bubbles stay on top, each with a 2px surface ring, fill at 0.7; labels for up to 10 of the biggest, each trying right, left, above and below and skipped when it would cover another bubble's centre or a placed label (9 placed, was 5) |
| `03-light-connection-flights.jpg` | `connection` on the world: 12 hubs, 16 directed links as great circles (sampled with `geoInterpolate`, split where they wrap, as Tokyo–San Francisco does across the Pacific), width linear in daily flights (1.5–8 px), thickest first, arrowheads sized with the stroke; hubs on both sides of the world fit the whole world; width key with the unit |
| `04-light-connection-europe-undirected.jpg` | `connection` on Europe, undirected: replication traffic between 8 regions; the one link with a `label` ("backup") is labelled at its midpoint |
| `05-light-hexbin-stations.jpg` | `hexbin`: 780 stations binned in projected pixels (d3-hexbin 0.2.2, radius 14), coloured by count on the sequential ramp's 4 mark-strength steps, 2px surface gap between cells; legend says points, cells and cell size and that cells redraw on resize; Tukey fence clips the top at 20 |
| `06-light-world-50m-iberia.jpg` | A world choropleth with `view` on Iberia and the Maghreb draws the 1:50m coast (`data-detail="50m"`), loaded only now; labels use the part of each country that shows (Algeria, Morocco, France are labelled where they are on screen) |
| `07-light-leaflet-route.jpg` | Street map: a delivery round as a route through the markers' `id`s, a white casing under a line in its tone, named for the keyboard ("Morning round · 14 km, 9 stops") |
| `08-light-leaflet-clusters.jpg` | 160 bike docks: grouped in a 56 px grid at the current zoom into numbered clusters, ringed in the worst status among them (red: a dock out of service); a click or Enter fits to the cluster's markers |
| `09-dark-connection-flights.jpg` | The flights in yaah dark: hubs in the foreground colour, arcs on `--chart-1` |
| `10-dark-hexbin-focus.jpg` | The hexbin in yaah dark (the ramp runs light-is-more on the dark surface); keyboard focus on a cell with its tooltip: centre, count, class |
| `11-dark-europe-bubbles.jpg` | Bubbles in yaah dark, rings in the dark surface colour |
| `12-dark-leaflet-clusters-zoomed-in.jpg` | Zoomed in on central Paris in yaah dark (tiles inverted by the existing filter): docks are single markers again, one pair still clustered |
| `13-tokyo-night-world-choropleth.jpg` | World choropleth in Tokyo Night: the theme's ramp; land and hatch from `--map-*` |
| `14-tokyo-night-connection-focus.jpg` | Europe traffic in Tokyo Night, focus on the Frankfurt–London link (outlined in the foreground colour) with its tooltip |
| `15-tokyo-night-election-map-outlined.jpg` | Fix for `2026-11-04-d3-maps-flow/18-20`: the election dashboard's map tab no longer hatches the 37 states outside the 14. Plain land would pass for the diverging scale's gray middle class (MI, NC, GA), so on a diverging scale with a gray middle, regions without a row are drawn as outlines on the surface; the legend's swatch says "Not in this set" in the same style |
| `16-light-election-map-focus.jpg` | The same in yaah light, focus on Georgia (a middle-class state, gray fill, clearly not an outline) |

## Checked on the way

- Release build (`pnpm build`): the built chunks were grepped for `eval(`, `new Function` and `Function(`. No match in `geo-map`, `world-50m.topo` or any new code; the only hit in the Leaflet `map` chunk is Leaflet's own `sortFunction(`, as on the base build.
- Bundle (gzip, vite's report): `geo-map` 18.2 → 23.2 KB (d3-hexbin, connection, hexbin, label placement); the Leaflet `map` chunk 46.7 → 48.4 KB (routes, grid clusters, percentile fit); new lazy `world-50m.topo` chunk 242.5 KB, loaded only for a world view narrower than 50° by 35°. `world`, `europe`, `us-states` chunks unchanged.
- Leaflet clusters: a vitro click on a cluster zooms in; Enter on a focused cluster does too (Leaflet's own keyboard handling listens for `keypress` only, so the cluster has its own `keydown`).

## Not changed, seen on the way

- Europe's frame is still height-bound in a wide card and shows much of Russia (`02`, `04`, `05`).
- A width legend with a worded unit reads "1 flights" (no plural forms; units are plain suffixes).
- Small countries that exist only at 1:50m (Malta, Andorra) stay plain land on the zoomed world: region ids are the 1:110m set's, so validation keeps one list.
