# Permissions folded into tool cards, trusted MCP servers, tool-call groups (2026-11-03)

Branch `feat/mdx-permissions-chat-layout`. Checked with vitro on the browser mock (`pnpm dev`, http://localhost:1420,
1440×900), light and dark. The chat is the mock's `triage ENG-142` recording (`src/dev/mock/permissions.ts`): two Linear
MCP reads, a read and a grep inside the chat's folders (auto-allowed), a failing `npm test`, and an `rm -rf build` the
user denies. What it shows is decided in Rust (`session/permissions.rs`); the mock replays the same entry shapes.

| File | What it shows |
|---|---|
| `01-pending-mcp-trust-light.png` | A pending Linear request: the usual options, and "Always allow tools from Linear in this chat" with the note that it covers every Linear tool, including ones that change things |
| `02-group-live-call-pending-{light,dark}.png` | After trusting Linear: the second Linear request and the reads were answered without asking; the six calls are one row ("· 1 failed · 4 auto-allowed", spinner), the call waiting on the user stays in sight under it, and its request keeps the full card. The dark one is the same turn in a project chat |
| `03-group-collapsed-denied-light.png` | Turn over: the group is one quiet row (2 failed), the denied `rm` stays as a one-line card |
| `04-group-expanded-chips-{light,dark}.png` | The group opened: each card's chip ("Auto-allowed · trusted server: Linear", "Auto-allowed · read-only in this chat's folders"); the failures in red; no separate permission cards |
| `05-chat-trusted-servers-dark.png` | The quick chat's header: the trusted servers menu, each removable, saying all their tools run without asking |
| `06-settings-permissions-dark.png` | Settings → Chat → Permissions: "Allow reads in the chat's folders without asking" and "Group consecutive tool calls" |
| `07-project-trusted-servers-{light,dark}.png` | After "Always allow tools from Linear in this project" in a project chat: the project's Trusted MCP servers list |

Notes:
- The chip is muted text with a small shield, beside the status badge; the reason shows when the column is at least 42rem
  wide (`@2xl`), and is always in the tooltip and to screen readers.
- The first dark capture of each screen caught the theme transition (low-contrast badges); the saved ones were taken once
  it settled.
- The group's open row keeps a hover tint in the captures because the pointer was on it.
