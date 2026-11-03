# Full-screen chat layout, folder requests and expanding UI (2026-11-03)

Branch `feat/terminals-and-resume`. Checked with vitro on the dev mock. "Before" is `HEAD` (926e451), served from a
separate worktree on port 1422. "After" is the working tree, on port 1423. Same prompts in both: a quick chat with
"show me the command output", then "compare between the current and last commit".

## The column

The user's report: a 2000 px full-screen window with the sidebar open showed a centred, roughly 1400 px column with wide
empty margins, and the user's own bubbles sat mid-column instead of on its right edge.

| width, sidebar | before | after |
| --- | --- | --- |
| 1280 × 900, shown | [before-1280-sidebar.png](before-1280-sidebar.png) | [after-1280-sidebar.png](after-1280-sidebar.png) |
| 1440 × 900, shown (scrolled to the end) | — | [after-1440-sidebar-end.png](after-1440-sidebar-end.png) |
| 1920 × 1080, hidden | [before-1920-no-sidebar.png](before-1920-no-sidebar.png) | [after-1920-no-sidebar.png](after-1920-no-sidebar.png) |
| 2000 × 1100, shown (the report) | [before-2000-sidebar.png](before-2000-sidebar.png) | [after-2000-sidebar.png](after-2000-sidebar.png) |
| 2560 × 1200, shown | [before-2560-sidebar.png](before-2560-sidebar.png) | [after-2560-sidebar.png](after-2560-sidebar.png) |
| 3440 × 1440, shown | [before-3440-sidebar.png](before-3440-sidebar.png) | [after-3440-sidebar.png](after-3440-sidebar.png) |

- **Before:** the column is capped at 1400 px and centred. The user message wrapper is 75ch wide and left-aligned, with
  the bubble at its right end, so the bubble lands somewhere in the middle of the column (most visible at 2000 and 2560).
  At 3440 the chat is a strip about 1400 px wide in a 3270 px pane.
- **After:** one `.chat-column` (index.css) is shared by the transcript, the composer and its error line. It is
  `width: 100%`, up to 2048 px, centred, with gutters of `clamp(1rem, 3cqi, 3rem)`. The scroller and the composer are each
  a `@container`, so the gutters follow the pane's width, not the window's: 48 px in a wide pane, 16 px in a narrow one.
  - User messages are `ml-auto w-fit`, capped at `min(75ch, 85%)`, so they hug the column's right edge, as in chat apps.
  - Agent prose stays on the left edge at 80ch.
  - Tool cards, permissions, UI entries and diffs take the full column.
  - The composer's `/` and `@` menu follows the gutter (`left: var(--chat-gutter)`).
- **3440:** the column stops at 2048 px and centres, leaving about 580 px either side with the sidebar open. Wider than
  that, the distance between agent prose on the left and user bubbles on the right got hard to follow.
- **1280:** the pane is about 990 px, so the column is full width with 30 px gutters.
- **Caveat:** classic (non-overlay) scrollbars make the transcript a few pixels narrower than the composer. Overlay
  scrollbars on macOS don't.

## Split panes, and the agent asking for a folder

- [after-1920-split-folder-request.png](after-1920-split-folder-request.png): two panes at 1920, sidebar shown. Each
  pane is its own column with its own gutters, and each pane's user bubbles sit on that pane's right edge. In the right
  pane, a quick chat (cwd `~/.yaah/scratch/…`) asks "give me the diff of my project in workspace of yaah". The agent calls
  `ui_request_folders` once (card: "Asking to add ~/Documents/workspace/yaah"), and the inline card waits: "The agent
  wants to add ~/Documents/workspace/yaah to this chat", its reason, and Add / Not now.
- [after-1920-split-folder-added-diff-review.png](after-1920-split-folder-added-diff-review.png): after Add, the card
  reads "→ Added" and the header shows 2 folders. `diff-review` with `repo` reads that repo (the mock refuses a `repo`
  outside the chat's folders, as Rust does). The "Added yaah to this chat" notice comes after the turn ends. The pane is
  under 900 px, so the review shows file tabs.

## Expanding a rendered UI

- [after-1920-diff-review-expanded.png](after-1920-diff-review-expanded.png): Expand (the caption's maximise button, or
  the review header's, or F) opens the same review in a 96vw × 92vh dialog titled with the component's name. The dialog
  is wide, so the review shows its file list. The list and the diff fill the dialog's height instead of the inline
  34 rem cap. The shot was taken after pressing `j` then `v` in the dialog: refund.go is selected and ticked, "1 of 6
  viewed".
- [after-1920-diff-review-closed-in-sync.png](after-1920-diff-review-closed-in-sync.png): after Esc, the inline entry
  still has refund.go selected and ticked ("1 of 6 viewed"). It is back at its inline size, with tabs in the narrow pane.
  This works because the dialog shows the same UI, not a copy: the UI is rendered once into a node that moves between
  the inline slot and the dialog. Its live `git.diff` reading, form drafts, selection and scroll carry over, and the
  source is never read twice.
