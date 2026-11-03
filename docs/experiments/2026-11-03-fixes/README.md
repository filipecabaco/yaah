# 2026-11-03: title-bar drag, Codex MCP duplicates, tool error text, new-chat loading

Branch `fix/drag-codex-mcp-errors`. Real app: the debug build (`target/debug/yaah` against `pnpm dev`)
with `HOME` set to a temp folder, so nothing in `~/.config/yaah` was written. Its `agents.json` had two
profiles: Codex (codex-acp 2.5.0 from `~/.yaah/agents`, `CODEX_HOME=~/.codex`, no prompt sent) and a
deliberately broken one (`sh -c 'echo … >&2; exit 3'`). Drags and clicks were posted with CoreGraphics
events from `osascript -l JavaScript`; the window position was read through System Events before and after.

| Shot | What it shows |
| --- | --- |
| `01-before-collapsed-bar.png` | Sidebar hidden (⌘B): the 52 px title bar. Before the fix a person's drag here did nothing. |
| `02-collapsed-bar.png` | The same bar after the fix. |
| `03-sidebar-expanded.png` | Sidebar back; its top row drags. |
| `04-starting-codex.png` | New Codex chat, first stage: "Starting Codex…", the sliding mark, composer waiting ("Codex is starting…"). |
| `05-starting-mcp-servers.png` | Second stage: "Starting MCP servers: node_repl, chrome-devtools, clickhouse, fetch and 2 more…" (Codex's own, from `~/.codex/config.toml`). |
| `06-chat-opened.png` | ~1.5 s later the chat opens in the same pane. |
| `07-start-failed.png` | The broken profile: "Broken agent didn't start", the error wrapped and readable, Retry / Switch agent / Close; composer disabled. |
| `08-switch-agent-menu.png` | Switch agent offers the other profiles. |
| `09-switched-to-codex.png` | Picking Codex retried into a working chat. |
| `10-collapsed-bar-over-chat.png` | Sidebar hidden over an open chat; the bar and the chat header both drag. |

## Drag results (window moved / tries)

| Region | Tauri's mousedown + fallback |
| --- | --- |
| Hidden sidebar's title bar, empty part | 9/9 (no pause and 150 ms pause before moving) |
| Same bar, on the Search button | 0/2 (stays a button) |
| Expanded sidebar's top row | 3/3 |
| Chat header | 6/6 |
| Fallback alone (Tauri's attribute renamed on the bar) | 5/5; control with no attribute anywhere: 0/2 |

Show sidebar and Hide sidebar still click.

The user's own trial (with a temporary probe, since removed) showed the press landing on the bar's
`<header data-tauri-drag-region="deep">`, not prevented, and the window not moving. So the attribute, the
pane grid and the capability were fine. Tauri's drag script asks the native side to drag
(`plugin:window|start_dragging`) and tao 0.37's `drag_window` passes `NSApp.currentEvent` to
`performWindowDragWithEvent`: when the event AppKit is handling as that request lands isn't a usable
mouse press (none, or a trackpad pressure/gesture event), the drag silently doesn't happen. Synthetic
events never hit that, which is why they always worked. `installDragFallback` asks again from the first
mousemove with the button held, while AppKit is handling a drag event; once a drag runs, AppKit tracks
the mouse itself, so the page sees no further moves and it asks at most once.
