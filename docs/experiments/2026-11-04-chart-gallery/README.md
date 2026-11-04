# Chart gallery (2026-11-04)

The browser mock's "chart gallery" reply: eight small dashboards, one per subject, each with a card, a stat row and one or two charts or a map. All numbers are made up. Source: `app/src/dev/mock/chart-gallery.ts`, routed in `app/src/dev/mock/chats.ts`, covered by `app/src/components/chart-gallery.test.tsx`. Shot at 1440x900 with `pnpm exec vite --port 1455`, quick chat, prompt "chart gallery".

Default colours are yaah Light (System appearance).

| File | Subject | Shows |
|---|---|---|
| `01-climate-line.png` | Climate | line, 3 series, reference line at the yearly average, `unit` |
| `02-sales-stacked-bar.png` | Product sales | stacked bar, total at each tip, `sort: value` |
| `03-traffic-stacked-area.png` | Web traffic | stacked area, latency stats |
| `04-sports-dumbbell.png` | Sports | dumbbell, `sort: gap`, categorical scale |
| `05-health-horizontal-bar.png` | Public health | horizontal bar, reference line at 80%, unit `%` |
| `06-finance-line-table.png` | Finance | single line, reference line at the start value, table |
| `07-logistics-map-bar.png` | Logistics | map of 8 hubs, bar of shipments (map zoomed out by hand, see findings) |
| `08-energy-stacked-area.png` | Energy | stacked area, end labels |
| `09-dark-climate.png`, `10-dark-sports.png`, `11-dark-energy.png` | yaah Dark | |
| `12-tokyo-night-climate.png`, `13-tokyo-night-sports.png`, `14-tokyo-night-energy.png` | Tokyo Night | |
| `15-solarized-light-climate.png`, `16-solarized-light-sports.png`, `17-solarized-light-energy.png` | Solarized Light | |

Shots 04, 10, 13 and 16 show a hover tooltip on the Northgate row: the pointer was left there by the previous click.

## Findings

See the report that came with this run; in short: the map does not fit its markers on first render, line and area charts drop their end labels when they would collide, the reference-line label can sit on top of data, the line chart value axis always starts at 0, and the dumbbell tooltip is clipped by its card.
