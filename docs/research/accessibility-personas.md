# Accessibility persona review

4 November 2026. A measured accessibility review of the interface, walking seven personas through one core flow. No app
code was changed. Evidence (screenshots, with a README): [`../experiments/2026-11-04-a11y-personas/`](../experiments/2026-11-04-a11y-personas/).

**Branch under test:** `fix/close-pane-on-shell-exit` (with another agent editing chart and theme files while this ran,
so the dev server reloaded the page several times; every step that a reload reset was redone).

## Method

**Flow every persona walked:** open Settings, set fonts, start a quick chat, send a message, read a reply with code,
open a tool group, answer a permission, split panes, close a pane, open and expand a terminal, Expand a UI, use ⌘K.

**How:**
- Chrome driven by vitro against the Vite dev server and the browser mock (`pnpm exec vite --port 1451`), 1440 × 900 and
  1024 × 700.
- Accessibility tree via vitro `snapshot` and `find`; roles, names, states and focus read with `evaluate`.
- Contrast computed in the page: colours resolved through a canvas (so `oklch()` and `color-mix()` resolve), alpha
  composited down the ancestor chain, WCAG 2.x relative luminance. Theme sweeps read the resolved `--background`,
  `--foreground`, `--muted(-foreground)`, `--border`, `--input`, `--ring`, `--destructive`, `--primary` tokens after each
  theme settled (the soft reply bubble is `bg-muted/50` over `--background`).
- Colour-vision deficiency: an SVG `feColorMatrix` filter on the root (Machado et al. matrices, severity 1.0) for
  screenshots, plus ΔE76 between simulated palette colours.
- Lighthouse accessibility via vitro `run_audit` on the home screen.
- Keyboard only: `press_key` (Tab, Shift+Tab, arrows, Esc, ⌘ combinations).
- Themes: yaah light and dark; GitHub Dark High Contrast, GitHub Light High Contrast, Solarized Dark and Light,
  Nord, Dracula, Night Owl, Vesper, Gruvbox Dark Soft and Light Soft, Catppuccin Latte, Ayu Light, Rosé Pine Dawn, Min Light.

**Limits (read these before trusting a "pass"):**
- **A browser mock in Chrome, not the app in WKWebView.** Focus behaviour, accessibility-tree mapping and the terminal
  renderer can differ. The mock's terminal used xterm's DOM renderer; the app uses WebGL (a canvas).
- **No real screen reader** (VoiceOver, NVDA). "Screen reader" findings come from the accessibility tree and ARIA
  attributes; announcement behaviour is inferred and marked UNVERIFIED.
- **`prefers-reduced-motion` and forced colours could not be emulated** (vitro `emulate` only does colour scheme). Those
  findings come from reading the CSS and are UNVERIFIED at runtime.
- Charts, the "Assembling UI" spinner and the Settings → Keyboard tab were not reached (no prompt reproduced charts in the
  mock; page reloads cost time). The chart palette was read from tokens, not from a rendered chart.
- The 12 px / 20 px labels in Settings are relative to the 14 px default: "12" sets the root to 16 × 12/14 = 13.71 px, so
  `text-xs` is 10.3 px; "20" sets the root to 22.86 px, so `text-sm` is 20 px.
- One viewer, one machine, one run. Contrast ratios are computed, not eyeballed; screenshots are JPEG.

## Findings

Severity: **blocker** (the persona cannot complete the flow), **major** (the flow works but with real loss), **minor**
(friction or a conformance gap with a workaround). WCAG is 2.2. "UNVERIFIED" means inferred, not measured.

| ID | Persona | Severity | Where | WCAG 2.2 | Evidence | Suggested fix |
|---|---|---|---|---|---|---|
| SR-1 | Screen reader | blocker (terminals) | `components/terminal/xterm-engine.ts` (no `screenReaderMode`); WebGL renderer | 1.3.1, 4.1.2 | Terminal exposes only a textarea named "Terminal input"; no `.xterm-accessibility` tree (`screenReaderMode: false`). With the WebGL renderer the output is a canvas, so a screen reader reads nothing. Mock used the DOM renderer, so the real app's behaviour is UNVERIFIED but follows from the setup. | Turn on xterm's `screenReaderMode` (at least as a setting or when VoiceOver is detected) and give the terminal region a name and role. |
| KB-1 | Keyboard | major | Settings, ⌘K, Expand, terminal Expand dialogs; permission card | 2.4.3 | Focus returns to `BODY` after closing Settings (opened with ⌘,), the palette (⌘K) and the Expand dialog (Esc), all measured from a focused composer or Expand button. After pressing "Yes" on a permission, the focused button is removed and focus drops to `BODY` as well. The next Tab restarts at the sidebar (12 stops before the chat). Exception: the terminal Expand dialog (⌘⇧Enter) did return focus to the terminal. | Restore focus to the opener on close (store `document.activeElement` before opening; return it in `onCloseAutoFocus`). After a permission answer, move focus to the next pending button or the composer. |
| FO-1 | Keyboard, low vision | major | `components/ui/button.tsx`, `input`, `--ring` / `--border` in `index.css` (light) | 1.4.11, 2.4.13 (AAA) | In yaah light the focus indicator is a `border-ring` (oklch 0.708) plus a 3 px `ring-ring/50`: border 2.49:1 and ring 1.54:1 against the card, both below 3:1 (permission "No" button focused: screenshot `small-02`). Composer, tool-group trigger and pane controls use the same recipe. Dark passes (ring 4.18:1). Of the other light themes measured, the ring token alone measures 3.3 to 21:1 against the page, so it carries the focus. | Make the light `--ring` at least 3:1 against `--background` and `--card` (about oklch 0.55) and use a solid 2 px ring. Keep a token check in `theme-map.test.ts` for `ring` against `background`. |
| TH-1 | Theme, low vision | major | `lib/theme-map.ts` (`MIN.muted = 3`, `theme-map.test.ts:10`) | 1.4.3 | Muted text is floored at 3:1 by design, but it is used for small text (descriptions, hints, paths, timestamps). On `--background` / on the bubble: Dracula 3.03 / 2.70, Solarized Dark 3.10 / 2.95, Vesper 3.57 / 3.28, Catppuccin Latte 3.27 / 3.16, Ayu Light 3.24 / 3.13, Min Light 3.64 / 3.47, Solarized Light 3.66 / 3.55, Night Owl 4.29 / 3.97, Nord 4.42 / 3.97. Even yaah light is 4.74 on the page, 4.54 on the bubble and **4.35** on `bg-muted` (the ⌘K / ⌘, hints, Lighthouse's one failing check). Pass: yaah dark 7.7 / 6.9, GitHub Dark HC 6.7, GitHub Light HC 4.97 / 4.72 (4.48 on `bg-muted`). | Raise the muted floor to 4.5:1 against `--background`, `--card`, `--muted` and the bubble surface (derive the bubble in the token step). Darken yaah light `--muted-foreground` to about oklch 0.5. |
| TH-2 | Theme, colour vision | major | `failed` badge and "· N failed" in `tool-group.tsx` / `entries.tsx`; `--destructive` | 1.4.3 | The red `failed` badge text on `bg-destructive/10` is **3.97:1** at 10.3 px in yaah light (measured on the rendered badge: fg `oklch(0.577 0.245 27.3)` on rgb 252,229,230). Computed for destructive over its 10 % tint: Nord 2.77, Solarized Dark 3.15, Ayu Light 3.10, Gruvbox Dark Soft 3.45, Catppuccin Latte 4.07, yaah dark 5.47. The bare "· 1 failed" count is 4.77 on white (passes). | Ensure `--destructive` is at least 4.5:1 on both `--background` and its own 10 % tint (darken in light, lighten in dark); add the tint case to the theme tests. |
| SM-1 | Small text | major | `tool-card` chips in `components/entries.tsx` (`text-[0.6875rem]`), `text-xs` throughout | 1.4.4, 1.4.12 | At 12 px interface the "Allowed" / "Auto-allowed" chip text is **9.4 px** (4.74:1); `text-xs` is 10.3 px; ⌘K / ⌘N hints are 10.3 px at 4.35:1; the sidebar section labels, email and "No chats" are 10.3 px. | Raise the floor: use `text-xs` for chips, and consider scaling the root so the smallest text is at least 11 px at the minimum setting (or raise the minimum interface size to 13). |
| LV-1 | Low vision | major | `lib/layout.ts:29` (`MIN_PANE = { w: 280, h: 160 }`), pane header in `components/chat.tsx` | 1.4.4, 1.4.10 | MIN_PANE is fixed px and does not scale. At 20 px on a 1024 px window (sidebar 288 px, two panes), the chat header title is **30 px of 142 px** ("tr…"), the cwd 61 of 289, the tool name 116 of 286, and the permission card sits under the composer; none has a `title`. No horizontal page scroll (`scrollWidth` = viewport). Screenshot `large-06`. | Scale the pane minimum with the root font size (`rem`), allow the header to wrap or drop the cwd first, add `title` to truncated titles, and auto-hide the sidebar when panes would go under the minimum. |
| LV-2 | Low vision | minor | `components/sidebar.tsx` (fixed 288 px width, 220–480 resizable) | 1.4.4 | At 20 px the agent picker shows "Claude dev@exa…": the email element is clipped by the trigger (no `title`, 148 of 148 px, so not detectable by `scrollWidth`). The sidebar width does not scale with the font. The picker's accessible value is the full "Claude dev@example.com". | Scale the default width with the root size (`rem`), and give the clipped email a `title` or a second line. |
| LV-3 | Low vision | minor | Settings dialog (`components/settings`) | 1.4.4, 1.4.10 | At 20 px the dialog is the full 1440 px wide (edge to edge, rounded corners cut off), and the title, description and 9 tabs take 185 of 900 px before any content (screenshot `large-01`). Content reflows fine; no overflow. | Cap width at `min(100vw - 2rem, 64rem)`, let the tab row scroll or wrap, and keep the header compact. |
| ST-1 | Small text | minor | Icon buttons, Map/Table tabs, tool-group rows, header chips, slider thumbs | 2.5.8 | At 12 px interface: icon buttons (`size-6`) are **20.6 × 20.6 px**, the Map/Table tabs 20.4 px tall, the tool-group row 20.5 px tall, the header Agent and folder chips 17.4 and 17.1 px tall, terminal header buttons 20.6 px. At 14 px the `size-6` buttons are 24 × 24 (pass); the slider thumb is 12 × 12 px at default size (the track is clickable and keys work). Spacing exceptions may apply, UNVERIFIED. | Use a minimum of `min-h-6 min-w-6` (24 px) in px for icon buttons, or pad hit areas with an `after:` pseudo-element as the switch already does. |
| KB-2 | Keyboard | minor | `components/terminal/terminal-pane.tsx`, `lib/shortcuts.ts` (`IN_TERMINAL`) | 2.1.2 (passes with a documented exit) | In a terminal Tab goes to the shell (measured: focus stays on "Terminal input"). The way out works: ⌘⌥← / ⌘⌥→ moved focus to the chat composer and back; ⌘⇧Enter closes the Expand dialog and returns to the terminal. Esc is inert in the Expand dialog by design, and the only hint is the dialog description in 10 px muted text ("⌘⇧Enter to go back"). ⌘, does nothing while a terminal has focus (not in `IN_TERMINAL`). | Keep it. Surface the exit key in the terminal pane's header tooltip, and let the dialog's close button take focus when the shell is not focused. |
| SR-2 | Screen reader | minor | `components/entries.tsx` (permission group); `components/chat.tsx` (log) | 4.1.3 | The permission card is `role="group"` named "Permission requested" inside the chat's `role="log"` (implicit polite live region). Nothing gets focus; the buttons are one Shift+Tab from the composer. Whether VoiceOver announces the card is UNVERIFIED. Streaming replies arrive in 48-character chunks inside the log, which could be chatty (UNVERIFIED). | Mark the permission card `role="alertdialog"`-like (an `aria-live="assertive"` summary) or move focus to its first button; announce the streaming reply in coarser steps. |
| SR-3 | Screen reader | minor | `components/ui-render.tsx`, `ui-blocks/*` (Expand button); `ui-blocks` dialog | 2.4.6, 2.5.3 | Six "Expand" buttons share one name, with no hint which UI they open; the dialog's title is the component slug "file-view" and its description "file-view v1", not the file name (`src/billing/refund.rs`). Dialog is otherwise correct (named, described, focus inside, background `aria-hidden`). | Name the button "Expand &lt;title&gt;" and use the UI's title as the dialog title. |
| SR-4 | Screen reader | minor | Map block (`ui-blocks/map.tsx`) | 1.1.1, 2.1.1 | Leaflet markers are SVG paths with no role, name or `tabindex` (measured: `role`, `aria-label`, `title`, `tabindex` all `null`). The Table tab is the text alternative and works. Zoom buttons are named "+" and "−" by Leaflet. | Keep the Table tab as the primary alternative; label markers or hide them from the tree (`aria-hidden`) and name the map region. |
| SR-5 | Screen reader | minor | Chat layout (`components/panes.tsx`, `App.tsx`) | 1.3.1, 2.4.1 | Home has a `main`, but in the chat/panes view there are 0 `main` landmarks (found: `aside` "Sidebar", `nav`, two `header`s). No skip link; the first Tab goes through 12 sidebar stops before the composer. Headings: the chat title is the H1 and an agent's own `# Release notes` renders as a second H1. | Put `role="main"` on the focused-pane area, add a skip link, and shift agent heading levels down by one. |
| SR-6 | Screen reader | minor | `components/settings/font-settings.tsx` | 4.1.2 | Both font-size sliders are named ("Interface size", "Code size") and have `aria-valuenow` (14, 12) but no `aria-valuetext`, so a screen reader says "14", not "14 pixels, default". The visible label is "14 px · default". | Set `aria-valuetext` to the visible label. |
| CV-1 | Colour vision | minor | `components/diff/rows.tsx`, `ui-blocks/*` line highlights | 1.4.1 | Diff meaning does not rely on colour: each line has a `+` / `−` marker and the counts are `+294 −0` text. But under deuteranopia the add/remove row tints (`bg-green-500/10`, `bg-red-500/10`) are almost the same (ΔE76 about 1.8 deuteranopia, 5.2 protanopia, 16 normal; **colours approximated, UNVERIFIED**). The amber line highlight in the file view (lines 3–4, screenshots) is colour only; whether it carries meaning is UNVERIFIED. | Keep the glyphs. Add a left border or an underline to highlighted lines. |
| FO-2 | Low vision | minor | `--input` token, select/combobox/textarea borders | 1.4.11 | Control borders are `--input` against the page: 1.26:1 in yaah light, 1.47 in yaah dark, 1.23 to 1.91 in the light themes measured (visible in `small-01`). The controls are also identified by text and a chevron, so this is a conformance gap, not a blocker. | Use a border of at least 3:1 for inputs, or a filled surface with 3:1 against the page. |
| MO-1 | Reduced motion | minor | `Loader2 animate-spin` in `entries.tsx`, `tool-group.tsx`, `ui-render.tsx`, `command-palette.tsx` and about 30 more places; `tw-animate-css` dialog fades | 2.2.2, 2.3.3 (AAA) | The start-up loader and the mark assembling respect `prefers-reduced-motion` (`index.html:91` swaps the slide for a slow opacity breathe; `index.css:381` removes the assemble). Sidebar transitions have `motion-reduce:transition-none`. **No rule covers the spinners** (`animate-spin` rotates at full speed), the dialog zoom/fade, or the smooth `scrollTo` in `diff-view.tsx:282` and `diff-review.tsx:178`. Runtime check not possible (UNVERIFIED). | Add a global `@media (prefers-reduced-motion: reduce)` rule: `.animate-spin { animation-duration: 3s }` (or a static icon), `animation: none` for `tw-animate` classes, and `behavior: "auto"` for smooth scrolls. |
| FC-1 | Low vision | minor | Focus ring and borders via `box-shadow` | 1.4.11 | `grep` finds no `forced-colors` rule. Focus rings are `box-shadow` (`focus-visible:ring-3`), which forced-colours modes drop. Not testable here (UNVERIFIED); macOS WKWebView does not use forced colours, WebKitGTK may. | Add `outline: 2px solid` under `@media (forced-colors: active)`. |

## Status

Fixed the same day on the same branch, then measured again in the browser mock. Screenshots and the numbers before and
after are in [`../experiments/2026-11-04-a11y-fixes/`](../experiments/2026-11-04-a11y-fixes/). Tests:
`src/lib/theme-contrast.test.ts` checks every built-in theme against the floors; `src/components/a11y.test.tsx` covers
focus return, landmarks, names, the sliders, map markers and the text floor.

| ID | Status | What changed (before → after where measured) |
|---|---|---|
| SR-1 | Won't fix (user decision) | The terminal is optional and can be left with ⌘⌥ arrows or by closing it. |
| KB-1 | Fixed | `DialogContent` (`components/ui/dialog.tsx`) notes what had focus as a dialog opens and gives it back on close, unless the caller's `onCloseAutoFocus` decides (the ⌘K palette's "go to the composer" still does). Settings, ⌘K, Expand and every other dialog: `BODY` → the opener. It holds under React's StrictMode. Answering a permission moves focus to the next request waiting in that pane, else its message box (`focusAfterPermission`, `lib/pane-focus.ts`). |
| FO-1 | Fixed | Light `--ring` oklch 0.708 → 0.6 (3.95:1 on the page, 3.78 on the sidebar). `ring-ring/50` halos now draw the solid ring colour (an unlayered rule in `index.css`, so no stock component changed). Permission "No" focused: ring 1.54 → 3.8, border 2.49 → 3.8. VS Code themes: `toTokens` floors `--ring` at 3:1 on the page, popovers and the sidebar (`FLOORS`, `theme-map.ts`). |
| TH-1 | Fixed | `toTokens` floors `--muted-foreground` at 4.5:1 on the page, `bg-muted`, the reply bubble, popovers, the sidebar, its selected row and dark control fills (`bg-input/30`). It moves toward the body text first, so it doesn't outshine it. yaah light 0.556 → 0.53 (4.35 → 4.82 on `bg-muted`). Dracula 2.39 → 4.69, Solarized Dark 2.79 → 4.62, Catppuccin Latte 3.05 → 4.91, Ayu Light 3.02 → 4.69, Vesper 2.95 → 5.25 (worst surface each). The build script and the theme tests assert the floors. Idle tabs use `text-muted-foreground`, not `text-foreground/60` (2.51 → 4.69 in Ayu Light). One limit: Solarized Dark's own body text is 4.75 on the page and under 4.5 on `bg-muted`, so muted text there ends up a little brighter than body text (5.14 against 4.75). |
| TH-2 | Fixed | `--destructive` is floored at 4.5:1 on the page and on its own 10% and 20% tints. yaah light oklch(0.577 0.245) → oklch(0.5 0.2): the `failed` badge 3.97 → 5.52. Nord 2.77 → 5.68, Solarized Dark 3.15 → 5.56, Ayu Light 3.10 → 5.57, Gruvbox Dark Soft 3.45 → 5.73. |
| SM-1 | Fixed | `text-xs` is `max(0.75rem, 11px)` and a new `text-2xs` is `max(0.6875rem, 11px)`. It replaces every `text-[0.6875rem]` and `text-[0.625rem]` (chips, badges, path hints); `sm` buttons are `max(0.8rem, 11px)`. At the 12px setting the "Allowed" chip goes from 9.4 to 11px and `text-xs` from 10.3 to 11px. Code text still follows the code size the user picks (10px is allowed). |
| LV-1 | Partly fixed | Pane headers: a container query drops the folder path under 32rem and the "no UI tools" badge under 28rem. The title keeps at least 4ch and has a `title` tooltip (30 → 102px at 20px in a 1024px window), and so does the project name. Tool-card chips show only their shield in narrow panes (tool names 27 → 90px). `MIN_PANE` scales with the interface size (`clampRatio(…, scale)`). `layout.rs` only bounds ratios and needed no change. Not done: hiding the sidebar on its own when panes would go under their minimum. That changes behaviour and needs a product decision. |
| LV-2 | Partly fixed | The sidebar's agent picker has a `title` with the label and the full email. The sidebar width still doesn't scale with the font: it is a saved pixel width the user drags. |
| LV-3 | Fixed | Settings is capped at `min(64rem, 100vw − 2rem)`: 1440 → 1394px wide at 20px, with margins and corners. The tab row still wraps when it has to. |
| ST-1 | Fixed | `xs` and `icon-xs` buttons, tab triggers, tool-group rows and the chat header's agent and folder chips are at least 24px. At 12px, icon buttons go 20.6 → 24 and the tool-group row 20.5 → 24. |
| KB-2 | Partly fixed | The terminal pane's title has a tooltip naming the way out (Tab and Esc go to the shell; ⌘⌥ arrows move to the next pane). Not done: moving focus to the Expand dialog's close button when the shell isn't focused. |
| SR-2 | Fixed (UNVERIFIED with a screen reader) | A waiting permission card has an `sr-only` `role="alert"`: "Permission requested: <title>". |
| SR-3 | Fixed | Expand buttons are "Expand <UI title>". The title is the agent's, or what the props name (a title or path), or the component in words ("File view"). The dialog takes the same title, and the slug and version move to its description. |
| SR-4 | Fixed | Markers are `role="button"`, in the tab order, and named by label and status ("Ohio (problem)"). Focus shows the tooltip and Enter or Space opens the details. The map is a region ("Map, 3 places") and a focused marker gets a ring-coloured stroke. |
| SR-5 | Fixed | There is one `main` around the panes; the panes' own `main`s became `div`s. The skip link "Skip to main content" is the first stop and lands in the focused pane's message box. An agent's `#` headings render one level down (an `h2` with `data-md="h1"`, still sized as before), so the chat title is the only `h1`. |
| SR-6 | Fixed | Sliders take `aria-valuetext`: "14 pixels, default", "12 pixels, follows the interface". |
| CV-1 | Fixed | Highlighted lines in the file view also get a 2px bar by the line number, a shape as well as the tint. The diff tints are unchanged; the `+` and `−` glyphs carry the meaning. |
| FO-2 | Fixed in light, not floored in dark | Light `--input` oklch 0.922 → 0.65 (1.26 → 3.23). Light VS Code themes are floored at 3:1 (Ayu Light 1.22 → 3.28, Catppuccin Latte 1.91 → 3.08). In dark themes `--input` also fills fields and outline buttons (`dark:bg-input/30`), so raising it would repaint them. Those controls are named by their text and chevrons. |
| MO-1 | Fixed (UNVERIFIED at runtime) | Under `prefers-reduced-motion: reduce`, `animate-spin`, `animate-in` and `animate-out` stop (spinners stay as a still icon beside their "running" text; dialogs appear without zoom or fade). CSS scrolling is `auto`, and the four scripted smooth scrolls use `scrollBehavior()` (`lib/motion.ts`). |
| FC-1 | Fixed (UNVERIFIED at runtime) | Under `forced-colors: active`, `:focus-visible` gets a 2px `Highlight` outline. |

Lighthouse accessibility on the home screen: 95 → **100**.

Found while fixing, and fixed too:
- Body text on dark popovers: Min Dark 4.27 and Solarized Dark 4.38. `--popover-foreground` is now floored at 4.5:1.
- Muted text on Dracula's purple control fill: 3.68 → 4.61.

## What passes

Measured unless marked.

- **Font settings scale the interface.** At 20 px the root is 22.86 px, rem text, spacing and icons follow, the terminal
  is 20 px, and there is **no horizontal scroll** at 1440 or 1024 (`scrollWidth` = viewport). No px-set text found
  (`text-[…px]` appears nowhere in `src/`; only the 52 px title bar, 7 px resize handles and switch sizes are px).
- **Dark is solid at every size.** yaah dark at 20 px: no text under 4.5:1 across the Settings dialog (after the theme
  transition settled); focus ring 4.18:1; body 18.97:1; borders carry the focus in dark.
- **High-contrast themes.** GitHub Dark High Contrast (body 17.6, muted 6.7, border 5.0, ring 9.2, destructive 7.0) and
  GitHub Light High Contrast (body 18.9, muted 4.97, border 15.4, ring 8.0, destructive 8.1) pass every check.
- **Code in the soft bubble.** Code text 19.8:1 on its white block; the bubble is 18.97:1 for body text; code blocks that
  overflow are keyboard-scrollable (the scroll container has `tabindex="0"`).
- **Colour is not the only signal.** `failed` has an ✕ icon and the word; `done` a ✓; the tool-group count is the text
  "· 1 failed"; diffs have `+` / `−` glyphs and counts; permission chips use words (Allowed, Auto-allowed) and icons; map
  markers are one colour; the chart tokens keep ΔE76 of at least 12.9 (deuteranopia), 25.0 (protanopia), 13.9
  (tritanopia) between the five slots (computed from `--chart-1…5`).
- **Roles, names and states.** Settings is a `dialog` with a heading and description; tabs are `tab` in a `tablist`
  with `tabpanel`; Appearance is a `radiogroup` of named `radio`s; both comboboxes and both sliders are named; pickers
  are `combobox` + `listbox` with `aria-expanded`; tool-group triggers expose `aria-expanded` (false/true) and an
  sr-only ", one still running"; the chat is a named `role="log"` with `aria-busy`; the start-up loader and the
  "Starting Claude…" screen are `role="status"` (the latter `aria-live="polite"`); the sidebar resize handle is a
  focusable `separator` with `aria-valuemin/max/now` (220/480/288).
- **No unnamed controls** in the chat view (0 buttons, inputs or tabs without a name; pane close buttons are named
  "Close this pane" and "Close terminal pane", and the terminal "Expand terminal", "Open in terminal app").
- **Dialogs trap and name.** ⌘K ("Command palette", described), Settings, Expand and the terminal dialog keep Tab inside;
  the rest of the app is `aria-hidden`; Esc closes all but the terminal dialog, which is deliberate.
- **Tab order** equals DOM order with no positive `tabindex`; all pane close buttons and the collapsed tool groups are
  reachable and operable with Enter (focus ring visible, though faint in light); ⌘⌥ arrows, ⌘D and ⌘K work from the composer.
- **Shortcuts are discoverable:** the palette lists ⌘N, ⌘T, ⌘D, ⌘⇧D, ⌘W, ⌃⌘= (Balance panes) beside each action, and
  the sidebar shows ⌘K and ⌘,. (Settings → Keyboard was not opened: UNVERIFIED.)
- **Start-up loader and mark** respect reduced motion (see MO-1 for what does not).
- **Lighthouse accessibility: 95** on the home screen; the one failed audit is colour contrast (the `⌘K` hint on
  `bg-muted`, 4.35:1; TH-1).

## Per persona

1. **Low vision (20 px / 20 px, dark, GitHub Dark HC).** Flow completes. Costs: LV-1 (pane headers lose identity at 1024
   px), LV-2 (email clipped), LV-3 (full-width Settings). Terminal at 20 px: 30 columns in a 559 px pane, legible.
   Focus rings are visible at that size and 4.18:1 in dark (FO-1 is a light-theme issue).
2. **Small text (12 px / 10 px).** SM-1 and ST-1. Chips 9.4 px; icon buttons 20.6 px. "10 px" code actually renders at
   10.29 px because code follows the interface until changed (label says 10 px).
3. **Colour vision.** CV-1, TH-2 (the red failed badge in light and several dark themes). Meaning is carried by text and
   glyphs everywhere I looked; charts are validated in tokens.
4. **Keyboard.** KB-1 is the main one. KB-2 (terminal) works by design. Tab order, pane close buttons and tool groups
   work. Shift+Tab from the composer reaches pending permission buttons in one to four stops.
5. **Screen reader (tree only).** SR-1 (terminal) is a blocker; SR-2 to SR-6 are minor. The permission card, tool groups,
   pane close buttons, sliders and comboboxes all have roles, names and states.
6. **Theme sweep.** TH-1, TH-2, FO-1, FO-2. Body text is at least 4.5:1 in every theme (the floor works); muted text is
   not.
7. **Reduced motion.** Loader and mark pass; spinners and dialog animations do not respond (MO-1, UNVERIFIED).

### Theme table (computed from resolved tokens)

Contrast ratios. `muted/bubble` is muted text on the `bg-muted/50` reply bubble.

| Theme | Body / bg | Muted / bg | Muted / bubble | Muted / muted | Border / bg | Ring / bg | Destructive / own tint |
|---|---|---|---|---|---|---|---|
| yaah light | 19.80 | 4.74 | 4.54 | 4.35 | 1.26 | 2.58 | 3.99 |
| yaah dark | 18.97 | 7.66 | 6.87 | 5.86 | 1.26 | 4.18 | 5.47 |
| GitHub Light High Contrast | 18.91 | 4.97 | 4.72 | 4.48 | 15.41 | 8.03 | 6.75 |
| GitHub Dark High Contrast | 17.57 | 6.67 | 6.22 | 5.68 | 5.04 | 9.24 | 6.30 |
| Solarized Light | 5.40 | 3.66 | 3.55 | 3.44 | 1.35 | 3.41 | 3.72 |
| Solarized Dark | 4.75 | 3.10 | 2.95 | 2.79 | 1.30 | 3.10 | 3.15 |
| Catppuccin Latte | 7.06 | 3.27 | 3.16 | 3.05 | 1.91 | 4.34 | 4.07 |
| Ayu Light | 6.10 | 3.24 | 3.13 | 3.02 | 1.22 | 3.29 | 3.10 |
| Rosé Pine Dawn | 6.66 | 4.02 | 3.89 | 3.75 | 1.23 | 3.47 | 3.60 |
| Gruvbox Light Soft | 9.23 | 3.87 | 3.72 | 3.56 | 1.26 | 5.25 | 3.76 |
| Min Light | 16.10 | 3.64 | 3.47 | 3.31 | 1.32 | 21.0 | 4.28 |
| Nord | 9.25 | 4.42 | 3.97 | 3.57 | 1.61 | 6.24 | 2.77 |
| Dracula Theme | 13.36 | 3.03 | 2.70 | 2.39 | 5.90 | 10.29 | 4.03 |
| Gruvbox Dark Soft | 9.57 | 4.72 | 4.26 | 3.83 | 1.61 | 4.88 | 3.45 |
| Night Owl | 13.54 | 4.29 | 3.97 | 3.62 | 4.29 | 7.98 | 4.85 |
| Vesper | 19.03 | 3.57 | 3.28 | 2.95 | 1.70 | 12.58 | 6.09 |

The yaah rows for border and ring read the tokens; in yaah light the focus border is `--ring` and measures 2.49:1 on
the card (FO-1). Borders at about 1.2 to 1.6:1 are decorative card edges and pass as such (1.4.11 does not require a
border that is not the only cue); the same token is used for input borders (FO-2).

## Prioritised fix list

1. **SR-1** turn on xterm `screenReaderMode`; name the terminal region. Only blocker.
2. **KB-1** restore focus to the opener on every dialog close, and after answering a permission.
3. **TH-1** raise the theme-map muted floor from 3 to 4.5 (against background, card, muted and the bubble); darken
   yaah light `--muted-foreground`. One change in `lib/theme-map.ts` fixes about ten themes.
4. **TH-2** keep `--destructive` at 4.5:1 on its own 10 % tint, light and dark.
5. **FO-1** a light-mode focus ring of at least 3:1 (solid, 2 px); add a theme test for `ring` against `background`.
6. **LV-1** scale `MIN_PANE` and the sidebar width with the root size; add `title` to truncated pane titles; handle
   narrow windows by collapsing the sidebar.
7. **SM-1 / ST-1** a floor on chip text (`text-xs`, not 0.6875 rem) and a 24 px minimum for icon buttons and tabs.
8. **MO-1** one global reduced-motion block for spinners, `tw-animate` and smooth scroll.
9. **SR-2, SR-3, SR-5, SR-6** announce permission requests, name Expand by its UI, add a `main` and a skip link, add
   `aria-valuetext` to the sliders.
10. **LV-2, LV-3, SR-4, CV-1, FO-2, KB-2, FC-1** polish: email tooltip, Settings width, map marker labels, line-highlight
    shape cue, input borders, terminal exit hint, forced-colours outlines.

## Not covered

- Real VoiceOver in WKWebView (focus order and announcements, the permission card, the terminal).
- Rendered charts (palette read from tokens only), the "Assembling UI" spinner, Settings → Keyboard, and the Expand
  dialog on a table or chart.
- `prefers-reduced-motion` and forced-colours behaviour at runtime.
- Screen magnification and Windows or Linux webviews.
