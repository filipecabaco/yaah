# Accessibility persona review

Browser mock (`pnpm exec vite --port 1451`), Chrome driven by vitro at 1440 × 900 (one shot at 1024 × 700). Not WKWebView, no
real screen reader. The findings, numbers and method are in
[`docs/research/accessibility-personas.md`](../../research/accessibility-personas.md). The dev server reloaded several times
(another agent was editing theme and chart files), so some states were rebuilt.

| File | What |
| --- | --- |
| `home-default.jpg` | Home screen at the defaults (light), the starting point |
| `small-01-settings-12px.jpg` | Settings → Fonts at 12 px interface / 10 px code: the whole dialog shrinks; small icon buttons and 10 px text |
| `small-02-permission-focus-ring.jpg` | Permission card at 12 px with keyboard focus on "No": the light-mode focus ring (border 2.49:1, ring 1.54:1) |
| `small-03-tool-group-failed-badge.jpg` | Expanded tool group at 12 px: the red `failed` badge (3.97:1), "Allowed" chips at 9.4 px, tool-group focus ring |
| `small-04-map-markers.jpg` | Map block with single-colour markers (no names, not focusable) and the Map / Table tabs at 12 px |
| `large-01-settings-20px.jpg` | Settings at 20 px / 20 px, light: the dialog spans the full window width and the header takes 185 px |
| `large-02-settings-dark-20px.jpg` | The same in dark (every text at least 4.5:1) |
| `large-03-permission-dark-20px.jpg` | Chat with a permission request, dark, 20 px: the card, chips and sidebar (email clipped to "dev@exa") |
| `large-04-split-terminal-dark-20px.jpg` | Chat beside a terminal at 20 px: 30 columns, legible, pane close buttons |
| `large-05-pane-picker-dark-20px.jpg` | The new-pane picker (a labelled combobox / listbox) at 20 px |
| `large-06-1024-wide-truncation.jpg` | 20 px on a 1024 px window: the chat title truncated to "tr…", the tool name and cwd cut off, the permission buttons under the composer |
| `theme-01-github-dark-hc-20px.jpg` | GitHub Dark High Contrast: sliders, buttons and code preview at 20 px |
| `theme-02-solarized-light-20px.jpg` | Solarized Light at 20 px: muted text at 3.66:1, accent-blue Yes button |
| `cvd-01-deuteranopia-diff.jpg` | A diff with a deuteranopia filter: the add-row tint nearly vanishes; `+` and the counts still carry the meaning |
| `cvd-02-protanopia-diff.jpg` | The same with a protanopia filter |
| `motion-01-startup-loader.jpg` | The start-up loader (the sliding mark, caught mid-animation after a hot reload) |

Not shot: the terminal Expand dialog, the ⌘K palette and the Expand dialog were checked from the accessibility tree and focus
behaviour only; the Expand dialog and palette were captured during the run but are not kept here.
