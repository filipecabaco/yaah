# Close button on every split pane

Browser mock on `pnpm dev` (port 1441), driven with vitro, 1440x900. The home screen was not shot (covered by the Vitest tests).

- `01-two-panes-chat-picker-light.jpeg`: chat | picker, light. Each pane has a small muted X at its top-right; the chat header leaves room for it.
- `02-three-panes-chat-picker-project-light.jpeg`: chat | picker over project, light.
- `03-three-panes-sidebar-hidden-dark.jpeg`: same, dark, sidebar hidden (⌘B). The traffic lights sit in the title bar row above the panes, so the buttons never meet them.

The button is `ghost` / `icon-xs` with the lucide `X`, at 60% opacity and full on pane hover or focus. Tooltip: "Close this pane" plus the ⌘W keys. Clicking it closed the project pane in the three-pane layout without changing the focused pane; the chat stayed in the sidebar. Terminal panes keep their own X.
