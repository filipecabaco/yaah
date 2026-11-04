# Bar, line and area on the d3 core; Recharts removed (2026-11-04)

Step 4 and 5 of `docs/research/d3-everywhere.md`: the `chart` primitive's bar, line and area kinds are now drawn by React as SVG on the shared figure core (`app/src/components/ui-blocks/viz/`), with d3-scale 4.0.2 and d3-shape 3.2.0 only computing scales, ticks and paths. Recharts 3.8.0 and the shadcn chart wrapper (`ui/chart.tsx`) are gone. The props agents send are unchanged. Also here: the sankey's neutral bands, which were too faint on dark themes (`2026-11-04-d3-maps-flow/12-tokyo-night-ci-sankey.jpg`, `17-dark-ci-sankey.jpg`).

Shot at 1440x900 with vitro against the browser mock (`pnpm exec vite` on port 5188, then a copy of the config with HMR and the file watcher off on 5189, because another session was editing the same tree and every edit reloaded the page). Prompts: "show me the chart gallery" (`app/src/dev/mock/chart-gallery.ts`), "build me an election dashboard" (`chats.ts`), "show me the flow graphs" (`flow-graphs.ts`). Themes switched through `src/lib/theme.ts`. Hover was driven with synthetic pointer events (vitro's own hover timed out on this page). All data is made up.

## Before (Recharts) and after

| Before | After | Shows |
|---|---|---|
| `before-01-light-line-climate.jpg` | `01-light-line-climate.jpg` | Three lines, 8px ringed dots, the "Lisbon yearly average" ref with its label in the right gutter, end labels dodged with a leader. Same ticks, same layout. The legend's keys are now short lines for a line chart (the key mirrors the mark) |
| `before-02-light-stacked-bar.jpg` | `02-light-stacked-bar-hover.jpg` | Stacked columns, 24px, rounded only at the top of each stack, 2px surface gaps (now real gaps in the geometry, not a stroke that narrowed the bar). Hover lifts the category's band and the tooltip lists every series and the total, beside the column so it never covers the total label |
| `before-03-light-stacked-area.jpg` | `03-light-stacked-area-crosshair.jpg` | Stacked bands with 2px surface seams, straight segments. Hover: crosshair hairline, every series' point on it, tooltip |
| `before-04-light-horizontal-bar-target.jpg` | `04-light-horizontal-bar-target.jpg` | Bars on their side, values at the tip, the 80% target over the bars with its label in the top gutter |
| `before-05-dark-line-climate.jpg` | `09-dark-line-climate.jpg` | yaah dark |
| `before-06-tokyo-night-stacked-area-energy.jpg` | `11-tokyo-night-stacked-area-energy.jpg` | Tokyo Night, the theme's own chart colours |

## New or changed

| File | Shows |
|---|---|
| `05-light-line-keyboard-focus.jpg` | Keyboard focus on October in the stock index (one tab stop, arrows, Home, End): ring on the column, crosshair, active dot, tooltip. Recharts' `accessibilityLayer` gave this only for its own tooltip; now every category is a named list item |
| `06-light-stacked-area-energy.jpg` | 100% stacked area, light |
| `07-light-line-table-view.jpg` | The Table view (unchanged) |
| `08-light-expand-stacked-area.jpg` | The Expand dialog: the chart fills the height left in the dialog (ticks about every 60px, up to 10) instead of keeping its inline height. The UI takes focus when moved in, so the first column shows its focus ring |
| `10-dark-stacked-bar-hover.jpg` | Hover on a stacked column, yaah dark |
| `12-light-election-dumbbell.jpg`, `13-tokyo-night-election-count-area.jpg` | The election dashboard: the dumbbell (unchanged) and the "Count over the night" stacked area with the crosshair |
| `20-tokyo-night-sankey-bands.jpg`, `21-dark-sankey-bands.jpg`, `22-light-sankey-band-hover.jpg` | Sankey bands: each band is now a filled outline, a quiet fill of the muted text (18% light, 24% dark) edged by a 1px hairline mixed like the map borders, 3:1 on the surface in all 65 themes (`theme-contrast.test.ts`, "flow bands"). Hover raises the fill to 40% / 48%. Compare `2026-11-04-d3-maps-flow/12-tokyo-night-ci-sankey.jpg` and `17-dark-ci-sankey.jpg` |

## Measured

- Chart chunk (`pnpm build`, gzip -9): 335.6 KB raw, 94.6 KB gz before (Vite reports 95.7); 23.6 KB raw, 8.5 KB gz after. It now also loads small shared chunks: the viz core (6.2 KB gz, there before too), d3-scale's linear and band pieces (3.0 KB gz), d3-shape's monotone curve (1.9 KB gz, shared with Mermaid). Main chunk `index-*.js`: 259.63 KB gz before, 259.64 after (no change).
- CSP: the built chunks were grepped for `eval(`, `new Function` and `Function(`. Before, 8 chunks matched, the chart chunk among them (decimal.js-light's `Function("return this")()`, pulled in by Recharts). After, 7: the chart chunk is clean; the rest are Mermaid (architecture, cose-bilkent, cytoscape, graphlib, a shared chunk), KaTeX, and Leaflet's map chunk (a false positive: `sortFunction(`).
- `pnpm audit`: 4 before (happy-dom high, minimatch moderate, katex low, deepmerge low), the same 4 after. None came from Recharts.
- Dependencies: removed `recharts` and with it redux, @reduxjs/toolkit, react-redux, redux-thunk, reselect, immer (and its pnpm override), decimal.js-light, victory-vendor, eventemitter3 and use-sync-external-store from the lockfile. Added `d3-shape` 3.2.0 (2022-12-20) and `@types/d3-shape` 3.2.0 (2026-08-21), pinned exactly, and a `d3-path@3` override at 3.1.0 (3.1.1 is from 3 November 2026).

## Not changed, seen on the way

- A `stacked: true` line is now drawn as plain lines on a fitted axis. Recharts drew unstacked lines too but on a zero-based axis of the sums, with end labels at band middles. Rust still accepts the prop on a line.
- `zero` and `domain` were accepted by `chart.rs` but never passed on by `ui-render.tsx`; they are now.
- Vertical bars label every category, as before; a long run of narrow columns can still collide (orientation turns horizontal only for long names).
