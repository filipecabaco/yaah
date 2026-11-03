# Chat layout and tool cards (2026-11-03)

Branch `feat/chat-and-creation-improvements`. Checked with vitro on the dev mock (`pnpm dev`, http://localhost:1420).
"Before" is `HEAD` (7f19deb) served from a separate worktree on port 1421, so the shared working tree was never stashed.

## Width

The same chat in both (prompt "Show me some cities in a scenario", the `live_scenarios` recording), scrolled to the
same entry: a stored component, a list item of agent text, the "data-table" render card and its table.

| width       | before                             | after                            |
| ----------- | ---------------------------------- | -------------------------------- |
| 800 × 900   | [before-0800.png](before-0800.png) | [after-0800.png](after-0800.png) |
| 1280 × 900  | [before-1280.png](before-1280.png) | [after-1280.png](after-1280.png) |
| 1440 × 900  | [before-1440.png](before-1440.png) | [after-1440.png](after-1440.png) |
| 1920 × 1000 | [before-1920.png](before-1920.png) | [after-1920.png](after-1920.png) |
| 2560 × 1200 | [before-2560.png](before-2560.png) | [after-2560.png](after-2560.png) |

- **Before:** everything sits in `max-w-3xl` (768 px) centred in the window. At 1920 px over half the chat area is empty
  and the table gets 700 px; at 2560 px it is a strip in the middle.
- **After:** the transcript column is `w-full max-w-[min(100%,1400px)]`. Tool cards, permissions, plans, notices and agent
  UI use all of it (the table gets 1,340 px at 1920 and 2560). Message text keeps a `max-w-[75ch]` measure (user bubbles too,
  right-aligned within it). It is left-aligned on the column's left edge, so text and cards share one left edge.
- **800 px:** the chat area is 512 px, narrower than either limit, so it looks the same before and after.
- **Composer:** it now sits on the same column, with the same edges as the cards above it. It used to be centred at
  768 px under a 1400 px column, which looked like it belonged to something else. The textarea stays one line until you
  type more (it grows to `max-h-48`). The `/` and `@` menu is capped at 42 rem, so a command's description isn't stretched across the window.
- A classic (non-overlay) scrollbar shifts the transcript about 7 px against the composer. macOS overlay scrollbars don't.

## Tool cards and command output (1440)

The mock's new "command output" replay (`src/dev/mock/chats.ts`, any prompt with "command output"): ToolSearch for
yaah-ui, `ui_catalog`, three shell commands with Claude's ` ```console ` fences (a `git diff`, a `git log`, cargo),
the fetch MCP server, Claude's WebFetch, and a `ui_render` of tabs with a map and a table.

- [after-tool-cards-1440.png](after-tool-cards-1440.png): after the turn. Commands and fetches are collapsed by
  default. The titles say what happened: "Read the UI catalog", "fetch: gov.uk/guidance/…", and "Rendered Where the invoices
  go" with "tabs, map, table" as its secondary text.
- [after-command-output-1440.png](after-command-output-1440.png): the diff and cargo cards opened. The diff is in yaah's
  diff view (with Raw beside it). The cargo output is code without the fence, one line per line, with tabs 4 wide.

## Switching the agent (1440)

- [after-switch-agent-picker-1440.png](after-switch-agent-picker-1440.png): the header's agent badge opens the ⌘K palette
  on "Switch this chat's agent…". The current agent is ticked, and an agent that isn't logged in says so.
- [after-switched-1440.png](after-switched-1440.png): the switch entry ("Switched to Claude (work) from Claude"). The badge
  and the composer's placeholder now name the new agent.
- [after-slash-agent-1440.png](after-slash-agent-1440.png): `/` in the composer shows yaah's own `/agent` (marked "yaah")
  above the agent's commands ("Commands from Claude").

## Caveat

vitro's fill-then-Enter leaves a `\n` in the textarea after sending, so the placeholder doesn't show in these shots,
before or after. It is a quirk of the driver; typing by hand doesn't do it.
