# Chart gallery fixes (2026-11-04)

The same browser-mock "chart gallery" as [2026-11-04-chart-gallery](../2026-11-04-chart-gallery/), re-shot after fixing what it found. Same file names, same framing: 1440x900, `pnpm exec vite --port 1457 --strictPort`, quick chat, prompt "chart gallery", driven with vitro. 01–08 are yaah Light (System appearance); 09–11 yaah Dark, 12–14 Tokyo Night, 15–17 Solarized Light. The sports shots (04, 10, 13, 16) show the tooltip on Northgate, the last row, by keyboard focus. 18 and 19 are new: the map in a narrow pane (720 px window) and in the Expand dialog.

Code: `app/src/components/ui-blocks/chart.tsx`, `chart-model.ts` (value axis, units), `chart-layout.ts` (label dodge, tooltip placement, chart font), `chart-font.ts`, `dumbbell.tsx`, `map.tsx`, `map-fit.ts`; tests in `chart.test.tsx`, `chart-layout.test.ts`, `chart-model.test.ts`, `map-fit.test.ts` and `chart-gallery.test.tsx`.

## Findings, before and after

| # | Finding | Before | After |
|---|---|---|---|
| 1 | Map didn't fit its markers on first render | 07: grey, zoomed into Germany, no markers; a resize loaded tiles but didn't fit; Athens and Gothenburg clipped once fitted by hand | 07, 18, 19: fitted on first render, inline, in a 359 px wide map and in the 1324 px Expand dialog. Every marker at least 76 px from the edge (measured). The fit waits for a real container size (ResizeObserver, then `invalidateSize`), refits on resize and new markers until the user pans or zooms, and one marker (or several on one spot) shows at zoom 13 |
| 2 | End labels dropped silently when values were close | 01: no end labels on the 3 climate lines; 03: none on the 4 traffic bands | 01: Cairo 15 °C, Lisbon 13 °C and Oslo -2 °C all drawn, nudged apart with short leader lines; 03: all four bands labelled. A label that still can't fit is dropped and reported, and the legend shows (it always does for 2+ series) |
| 3 | Reference-line labels drawn over the data | 01: "Lisbon yearly average" over the Dec points; 05: "Target 80%" over Country A's bar; 06: "Start 100" under the line | Horizontal lines label in the right gutter, dodged with the end labels (01, 06); vertical lines label in a gutter above the plot (05). Text in `--muted-foreground` with a halo in the surface colour; the line a solid 1px hairline in the same token, under lines and areas, over bars |
| 4 | Line value axis always started at 0 | 06: 100–118 squashed into the top fifth; 01: "-10 °C" wrapped onto two lines | 06: 95–120 (100–120 from the data, one step more because a ref sits at 100); 01: -5 °C to 30 °C. Bars and stacks keep their zero baseline. Ticks are one line of text, and the axis is as wide as its widest tick |
| 5 | Dumbbell tooltip cut off by the card, over the axis labels | 04: Northgate's tooltip ran below the card into the axis | 04, 10, 13, 16: the tooltip stays inside the plot, above the axis (beside the outer dot, flipped left near the right edge, above or below when neither side has room). Keyboard focus shows the same one |
| 6 | Dumbbell `diverging` scale coloured by dot value | — | Documented in `ui-primitives.json` and the agent guide: for signed values such as margins; for before → after of raw values use the default or `categorical`. No `scale.by` option |
| 7 | Stacked areas faint in light, muddy in dark; "100%" clipped ("l00%"); labels mid-band | 03, 08: 10% washes; 11, 14: near-invisible bands; 08: "l00%" | 03, 08, 17: bands at 45% in light; 11, 14: 55% in dark, each band separated by a 2px surface seam (as stacked bars are); single areas keep the 10% wash under their line. "100%" whole. End labels at each band's middle at the last point, through the same dodge |
| 8 | `unit: "k"` rendered "16 k" | 02: "16 k" ticks | 02: "15.4k", "20k", and "0" at the baseline. Symbols and magnitude suffixes attach (k, M, %, °, °C), currency leads ($12), words get a space (ms), and a leading space the agent wrote is kept (" pts", " °C") |
| 9 | Axis and legend text fixed at about 11px | 11px everywhere | Chart text is the interface's text-xs (12px at the default size), follows Settings → Fonts, never under 11px. Label widths and gutters are measured at that size |
| 10 | Solarized Light stat values and headings low contrast | 15–17 | No change, by design: the stat value and card title use `--foreground`, which is Solarized Light's own text colour (#586e75 on #fdf6e3), measured at 5.40:1 in the page, above the 4.5:1 floor. yaah derives nothing there. The theme is simply low contrast by design |

## Not changed, seen on the way

- In the 720 px window (18) the logistics stat row clips "Rotterdam" at the card's edge: the stat grid doesn't wrap. Unrelated to charts.
- The map now fits at whole zoom levels. Quarter steps (`zoomSnap: 0.25`) fitted tighter but left hairline seams between scaled tiles in Chrome, so they were dropped.
