# Accessibility fixes, re-measured

The fixes for the findings in [`docs/research/accessibility-personas.md`](../../research/accessibility-personas.md) (the
"Status" section there lists each one), checked in the browser mock (`pnpm exec vite --port 1453`), Chrome driven by vitro
at 1440 × 900 and 1024 × 700. It's not WKWebView and there's no real screen reader. Contrast was computed in the page the
same way the review did it: colours resolved through a canvas, alpha composited down the ancestor chain, WCAG 2.x
luminance. Another agent was editing chart and theme files during the run, so the dev server reloaded several times, and
every step a reload reset was done again.

| File | What |
| --- | --- |
| `small-01-permission-focus-ring-12px.jpg` | Permission card at 12 px, keyboard focus on "No": the solid 3 px ring and the border are 3.8:1 on the card (before: 1.54 and 2.49) |
| `small-02-settings-12px.jpg` | Settings → General at 12 px: field borders at 3.23:1 (before: 1.26), idle tabs at `muted-foreground`, icon buttons 24 × 24 |
| `small-03-tool-group-failed-badge-12px.jpg` | Expanded tool group at 12 px: `failed` badge 5.52:1 at 11 px (before: 3.97 at 10.3 px), "Allowed" chips 11 px at 5.25:1 (before: 9.4 px), group row 24 px tall (before: 20.5) |
| `small-04-skip-link-12px.jpg` | The skip link, first Tab stop on the page; Enter lands in the message box |
| `large-01-1024-wide-20px-header.jpg` | 20 px on a 1024 px window, chat beside a new pane: the title gets 102 px (before: 30 px, "tr…") and has a `title` tooltip, the folder path is dropped, chips show only their shield so tool names get 90 px (was 27) |
| `large-02-settings-20px.jpg` | Settings at 20 px: 1394 px wide in a 1440 px window, with margins and rounded corners (before: 1440, edge to edge) |
| `theme-01-ayu-light-map.jpg` | Ayu Light, a chat with a map: muted text and the ⌘K hints at 4.69:1 or more (before: 3.02 to 3.24) |
| `theme-02-ayu-light-map-marker-focus.jpg` | The same map with keyboard focus on the London marker: a named button ("London · 412") that shows its tooltip on focus |
| `theme-03-dracula-tool-group.jpg` | Dracula, the expanded tool group: every muted text and badge at 4.61:1 or more (before: muted 2.39 to 3.03, failed 4.03) |

## Measured in the page

Token contrast after the fixes. The review's numbers are in brackets.

| Theme | Muted / bg | Muted / bubble | Muted / bg-muted | Ring / bg | Destructive / 10% tint | Input / bg |
|---|---|---|---|---|---|---|
| yaah light | 5.25 (4.74) | 5.03 (4.54) | 4.82 (4.35) | 3.95 (2.58) | 5.55 (3.99) | 3.23 (1.26) |
| yaah dark | 7.66 | 6.87 | 5.86 | 4.18 | 6.19 (5.47) | 1.48 (dark: not floored) |
| Dracula | 5.93 (3.03) | 5.28 (2.70) | 4.69 (2.39) | 10.29 | 5.70 (4.03) | 5.90 |
| Ayu Light | 5.03 (3.24) | 4.86 (3.13) | 4.69 (3.02) | 3.29 | 5.57 (3.10) | 3.28 (1.22) |
| Solarized Dark | 5.14 (3.10) | 4.87 (2.95) | 4.62 (2.79) | 3.44 (3.10) | 5.56 (3.15) | 1.30 (dark: not floored) |
| Catppuccin Latte | 5.27 (3.27) | 5.09 (3.16) | 4.91 (3.05) | 4.34 | 5.84 (4.07) | 3.08 (1.91) |
| Vesper | 6.35 (3.57) | 5.81 (3.28) | 5.25 (2.95) | 12.58 | 6.08 | 1.70 (dark: not floored) |

The rendered muted text on the home screen (every `.text-muted-foreground`, `kbd` and tab label): yaah light 4.82 at
worst, yaah dark 5.86, Ayu Light 4.69, Dracula 4.61 (the sidebar's Search on Dracula's purple `bg-input/30` fill, 3.68
before the field fill joined the floor's surfaces).

- **Focus return**, with keys: Settings from the sidebar button back to that button; ⌘, and ⌘K from the message box back
  to it; Expand back to "Expand Where the invoices go"; "No" on a permission (Enter) to the message box. ⌘K first came
  back to `BODY` in the dev build: React's StrictMode re-ran the dialog's layout effect after the palette's input had
  taken focus. Fixed, and there's a StrictMode test for it now.
- **Landmarks**: one `main` in the chat view (before: none there, one per pane elsewhere); the skip link is the first
  stop.
- **Names**: Expand is "Expand Where the invoices go"; its dialog is titled "Where the invoices go"; markers are
  "London · 412", "Berlin · 198", "Lisbon · 87" in a region "Map, 3 places"; the font sliders say "14 pixels,
  default", "12 pixels", "12 pixels, follows the interface".
- **12 px**: the smallest interface text is 11 px (before: 9.4 px chips and 10.3 px `text-xs`). `sm` buttons are 11 px
  (were 10.97). Code text follows the code size, so it can still be 10.3 px when the code size is 10 px.
- **Lighthouse accessibility, home screen: 100** (before: 95; the one failure was the ⌘K hint at 4.35:1).

Not checked at runtime: `prefers-reduced-motion` and forced colours (vitro's `emulate` does colour scheme only). The rules
are in the built CSS (`[class*=animate-spin],[class*=animate-in],[class*=animate-out]{animation:none}` under
`prefers-reduced-motion: reduce`; `:focus-visible{outline:2px solid highlight}` under `forced-colors: active`).
