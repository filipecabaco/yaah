# Permission scopes, saved tool results, web searches

4 November 2026. `pnpm dev` on port 1446 with the browser mock (no agent), driven with vitro at 1440×900. The rule is
`app/src-tauri/src/session/permissions.rs`, the state `session/trust.rs`; the mock (`src/dev/mock/permissions.ts`)
mirrors them for the UI. Research: `docs/research/permissions.md` ("Since"), `docs/research/permissions-tool-results.md`.

| File | What it shows |
|---|---|
| `01-card-quick-chat-scopes.png` | A quick chat (`~/.yaah/scratch/…`): "Always allow tools from Linear" offers **In quick chats** and **In all chats**; there is no "this chat" scope for a quick chat. |
| `02-header-in-quick-chats.png` | After "In quick chats": the header's shield lists `claude_ai_Linear` and says the tools run without asking **in quick chats**. |
| `03-chips-and-saved-tool-result-note.png` | A second quick chat (`saved results` in the mock): its header already shows the shared server (1). The WebSearch card's chip says "web search allowed in Settings", the Read of Claude's saved tool result "Claude's saved tool result from this chat", and the Bash read-back still asks, with "Claude is reading a saved tool result" above the command. |
| `04-card-project-chat-scopes.png` | A chat in the "billing revamp" project: **In this chat**, **In this project**, **In all chats**. |
| `05-settings-web-search-and-all-chats.png` | Settings → Chat → Permissions: the updated copy, "Allow web searches without asking" (off by default, turned on here), and "MCP servers trusted in all chats" with `claude_ai_Linear` (trusted from 04) and its Remove button. |

Each trust button's accessible name is the full sentence ("Always allow tools from Linear in quick chats"); the visible
text is the scope. Buttons are stock shadcn `sm` ghost buttons (≥ 24 px). The red ring in 03 is vitro's click marker.
