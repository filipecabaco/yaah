# Chat bubbles: user on the right, agent reply in a soft bubble (2026-11-03)

Branch `feat/mdx-permissions-chat-layout`. Checked with vitro on the dev mock (`pnpm dev`, http://localhost:1420).
"Before" is the working tree before the change and "after" is with it, using the same chats in both: a quick chat with
"show me the command output" then a longer user message (the Markdown reply with a code block), and a second chat with
"Show me some cities in a scenario" (agent text split around tool calls and rendered UI, then a long final reply). The
`webkit` shots come from the same dev server loaded in a real `WKWebView`, Tauri's engine on macOS (a throwaway Swift
probe kept outside the repo, with a non-persistent data store).

## The user's bubble

The bubble sat mid-column in the old layout. The user message wrapper was `flex max-w-[75ch] flex-col items-end` with no
`ml-auto`, so it was a 75ch box anchored to the column's left edge, and the bubble ended where that box did.
`fullscreen-layout` (`0d3951e`) changed the wrapper to `ml-auto w-fit max-w-[min(75ch,85%)]`. Measured on this branch,
nothing above the wrapper narrows it (`.transcript-entry` and `.chat-column` both span the column). The bubble's right
edge is the cards' right edge in Chromium and in WKWebView: 1952 px for both at 2000 px, and 692 px for both in a 420 px
pane. A mid-column bubble in the real app means the build predates `0d3951e`. The layout test now also checks that no
width class sits between the message and the column.

## The agent's reply

|                                      | before                                                                             | after                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 2000 × 1100, light, cities           | [before-2000-light-scenarios-end.png](before-2000-light-scenarios-end.png)         | [after-2000-light-scenarios-end.png](after-2000-light-scenarios-end.png)           |
| 2000 × 1100, light, command output   | [before-2000-light-command-output.png](before-2000-light-command-output.png)       | [after-2000-light-command-output.png](after-2000-light-command-output.png)         |
| 2000 × 1100, WKWebView (system dark) | [before-2000-webkit-command-output.png](before-2000-webkit-command-output.png)     | [after-2000-webkit-command-output.png](after-2000-webkit-command-output.png)       |
| 1440 × 900, dark, cities             | [before-1440-dark-scenarios-end.png](before-1440-dark-scenarios-end.png)           | [after-1440-dark-scenarios-end.png](after-1440-dark-scenarios-end.png)             |
| 420 px pane, light, cities           | [before-420-pane-light-scenarios-end.png](before-420-pane-light-scenarios-end.png) | [after-420-pane-light-scenarios-end.png](after-420-pane-light-scenarios-end.png)   |
| 420 px pane, light, Markdown reply   | —                                                                                  | [after-420-pane-light-command-output.png](after-420-pane-light-command-output.png) |
| 420 px pane, dark, cities            | —                                                                                  | [after-420-pane-dark-scenarios-end.png](after-420-pane-dark-scenarios-end.png)     |

- **Before:** bare prose capped at `80ch` on the left (743 px of a 1616 px column at 2000 px), next to full-width cards.
- **After:** each agent text entry is a soft bubble: `w-full max-w-[min(100ch,100%)] rounded-lg bg-muted/50 px-4 py-3
leading-relaxed`, with no border. Like the user's bubble it uses a muted fill and the same corners, but at half
  strength, so it reads quieter than the user's bubble and is clearly not a tool card (cards are `border bg-card`). It
  is 928 px at 2000 px and full width in a 420 px pane.
- The width is fixed, not `w-fit`. A short reply gets a wide bubble, but the width doesn't change as text streams in,
  and charts, diagrams or MDX blocks inside have a width to fill. All bubbles share one left and right edge.
- `.agent-reply` in `index.css` sets the prose spacing inside the bubble: 0.85em between blocks (0.6em before), more
  space above headings, 0.3em between list items. Code blocks use the page colour with a border so they stand out
  from the muted fill. Inline code is unchanged. `markdown.tsx` is untouched.
- A reply split around tool calls is one entry per run, so each run gets its own bubble (the cities chat has seven
  runs between its cards). An agent entry with no text yet renders nothing, not an empty bubble.
- Thoughts are unchanged (the collapsible `border-l-2` block).
- Everything uses theme tokens (`--muted`, `--background`, `--border`). In VS Code themes, `theme-map.ts` derives
  `--muted` from the background (5% towards the text colour in light themes, 8% in dark), so the fill is never
  invisible.
- The map in `after-2000-light-command-output.png` is still loading its tiles after the chat was switched back to.
  This is unrelated to the change; the WKWebView shot shows the same map fully drawn.

## Follow-up: widths at 2560 px

The reply's cap went from 100ch to 140ch, so it covers more of a wide column, and the bubble now fits short text
(`w-fit`). A reply holding wide blocks (code, tables, diagrams, MDX alerts, tabs or details) takes the full 140ch through
`.agent-reply:has(…)` in `index.css`.

| Shot | What it shows |
| --- | --- |
| [before-2560-short-reply-full-width.png](before-2560-short-reply-full-width.png) | a one-line reply in a fixed-width bubble, mostly empty |
| [after-2560-short-reply-fits.png](after-2560-short-reply-fits.png) | the same reply fitting its text |
| [after-2560-long-reply.png](after-2560-long-reply.png) | an MDX reply at the full 140ch, beside the user's bubble at the right edge |
