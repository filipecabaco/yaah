# Map gallery (2026-11-04)

The browser mock's "map gallery" reply: eight cards, each a made-up dataset on a map at a different scale or density. Source: `app/src/dev/mock/map-gallery.ts`, routed in `app/src/dev/mock/chats.ts`, covered by `app/src/components/map-gallery.test.tsx`. Shot at 1440x900 with `pnpm exec vite --port 1459`, quick chat, prompt "map gallery", tiles loaded (all `img.leaflet-tile` complete) before each shot. Default is yaah Light (System appearance).

| File | Example | Shows |
|---|---|---|
| `01-city-bike-stations.png` | City: 28 bike stations, Lisbon | close markers, tone by bikes left, number in label |
| `01b-city-hover-label.jpg` | same | hover tooltip with the label |
| `02-country-store-revenue.png` | Country: 9 stores in Portugal | revenue in the label, plus bar; Madeira and Azores stretch the fit |
| `03-continent-edge-locations.png` | Continent: 12 edge sites in Europe | tone by status, status in label, legend line |
| `03b-continent-status-table.png` | same, scrolled | status table |
| `04-world-offices.jpg` | World: 10 offices, 6 continents | far-out fit |
| `05-route-delivery-round.jpg` | Route: delivery round, 8 numbered stops | numbers in labels, stop table; no line between stops |
| `06-single-point.jpg` | Single point | single-marker zoom |
| `07-dense-200-stations.jpg` | Dense: 200 weather stations | overlap, fit |
| `08-mixed-dashboard.jpg` | Mixed: map, bar, four stat tiles | map beside a bar |
| `09-dark-city.jpg`, `10-dark-continent.jpg`, `11-dark-dense.jpg` | yaah Dark | tiles stay light |
| `12-tokyo-night-continent.jpg`, `13-tokyo-night-mixed.jpg` | Tokyo Night | default marker and bar follow the theme |
| `14-expand-dialog-continent.jpg` | Expand dialog (Tokyo Night) | map is 252 px tall and zoomed far out |
| `15-narrow-pane-mixed.jpg`, `16-narrow-pane-continent.jpg` | ~560 px split pane (Tokyo Night, after two ⌘D) | map and bar squeezed side by side, bar axis labels collide |

Findings are in the report that came with this run.
