# Charts: dumbbell, mark specs, themed palette (4 November 2026)

The browser mock (`pnpm dev` on port 1449, vitro, 1440×900). Prompt: "Build me a US election dashboard" (routed to the `election` recording in `app/src/dev/mock/chats.ts`). Numbers are illustrative.

| Image | What it shows |
|---|---|
| `before-grouped-bars-light.png`, `before-grouped-bars-dark.png` | Before: the old renderer (HEAD, run from a throwaway worktree) with the same data as grouped bars: dashed grid, 36px bars, poll and result hard to compare per state |
| `after-dumbbell-light.png`, `after-dumbbell-dark.png` | After: `kind: "dumbbell"`, sorted by gap, Tie line at 0, gap labelled at each row end, poll hollow and result filled, coloured by side on a 5-bin diverging scale with its legend; the light one shows the hover tooltip (keyboard focus shows the same) |
| `after-stacked-area-light.png`, `after-stacked-area-dark.png` | The count over the night: stacked area with straight segments (no spline over a stack), a 10% wash, solid hairline grid, and end labels in text colour |
| `existing-bar-and-line-light.png`, `existing-bar-and-line-dark.png` | An existing chart card (the "cities scenario" recording): bars capped at 24px, solid grid, 8px dots with a 2px surface ring, the line's end label |
| `theme-dracula.png` | Dracula: series from its terminal colours; the diverging poles fall back to yaah's (its blue is violet, too close in hue to read as opposite its red). The grid follows Dracula's own, louder border colour |
| `theme-tokyo-night.png` | Tokyo Night: its own `charts.*` colours pass after a chroma nudge |
| `theme-github-light.png` | GitHub Light: terminal colours, nudged to 3:1 on white |
| `theme-solarized-light.png` | Solarized Light: terminal colours on its cream canvas |
| `theme-nord-fallback-area.png` | Nord: its pastel `charts.*` and terminal colours are under the chroma floor (read as gray), so yaah's dark palette is used, nudged to its canvas |
