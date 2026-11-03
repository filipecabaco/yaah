# 2026-11-03: Resume a session…

Branch `feat/terminals-and-resume`. Bringing sessions started outside yaah (in the Claude Code or Codex CLI)
into a yaah chat and carrying on with them: ACP `session/list` on the profile's own agent process, then
`session/load`, whose replay is recorded as the chat's transcript this time (`src-tauri/src/session/resume.rs`).

The shots come from the browser mock (`src/dev/mock/resume.ts`, believable sessions per Claude profile) at
1440 × 900 in vitro. Other agents were saving files on the same branch, so `pnpm dev` on :1420 reloaded
every few seconds. The shots were taken from a second Vite server on :1430 with HMR and file watching off:
the same code and the same mock, just not reloading. Its temporary config has been removed.

| Shot                             | What it shows                                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-palette-action.png`          | ⌘K → "resume": **Resume a session…**, "started in an agent's CLI".                                                                                                                                                |
| `02-pick-agent.png`              | First step: the agent profiles that list sessions, or haven't said yet. Profiles whose last `initialize` had no `sessionCapabilities.list` are left out and named below the list.                                 |
| `03-asking-the-agent.png`        | While the profile's agent starts and lists: "Asking Claude for its sessions…".                                                                                                                                    |
| `04-session-list.png`            | The list: title (or _Untitled session_), folder, relative time, and "Load older sessions" when the agent gives a `nextCursor`.                                                                                    |
| `04b-list-before-layout-fix.png` | The same list before the fix. The time sat right after the folder badge, because shadcn's hidden check icon also takes `ml-auto`. Now the title fills the row and the time is a fixed right-aligned column.       |
| `05-search.png`                  | The search matches the title and the folder ("billing" finds a title and `api-billing`).                                                                                                                          |
| `06-imported-with-history.png`   | Enter: the session opens in the focused pane with its history (messages, thought, tool call, plan, follow-up). Its folder (`~/workspace/web`) is inside the "billing revamp" project, so the chat is filed there. |
| `07-pane-picker-action.png`      | ⌘D: a new pane's picker has **Resume a session…** under Start.                                                                                                                                                    |
| `08-pane-pick-agent.png`         | The same steps inside the pane (Esc goes back to the picker).                                                                                                                                                     |
| `09-pane-already-in-yaah.png`    | The session imported above shows as **Already in yaah**, with a chat icon. Enter opens that chat; nothing is imported twice.                                                                                      |
| `10-empty-state.png`             | A profile with no sessions: "Claude · Bedrock has no sessions yet. Ones you start in its CLI show up here."                                                                                                       |
| `11-cant-list.png`               | A profile whose agent can't list (OpenCode here, its report not known yet): Rust's refusal is shown, "OpenCode · OpenRouter can't list its sessions."                                                             |
| `12-home-quick-chat-menu.png`    | The home screen's Quick chat menu ends with **Resume a session…**, which opens the palette's page.                                                                                                                |

## Real profile, read-only

`YAAH_LIVE_ACCOUNT=personal cargo test --lib live_resume_lists -- --ignored --nocapture` starts the `personal`
Claude profile's agent (claude-agent-acp 0.100.0, its own `CLAUDE_CONFIG_DIR`) the way the app does and only
lists its sessions. It imports nothing, sends no prompt and writes no chat:

```
personal: 5 sessions in 1 page(s) in 0.5s; 3 already in yaah, 0 untitled
```

It printed the five titles. Three of them are chats yaah started, which `session/list` reports too, so they're
marked "already in yaah".

## Which adapters list and load

| Agent                                                                                   | `loadSession` | `sessionCapabilities.list`             | How it was checked                                                   |
| --------------------------------------------------------------------------------------- | ------------- | -------------------------------------- | -------------------------------------------------------------------- |
| claude-agent-acp 0.99.1 and 0.100.0                                                     | yes           | yes (pages of 1000, cursor `offset:N`) | bundled source in `~/.yaah/agents/`                                  |
| codex-acp 2.5.0                                                                         | yes           | yes                                    | bundled source in `~/.yaah/agents/`                                  |
| Gemini CLI 0.63.0 (`--experimental-acp`)                                                | yes           | no (no `sessionCapabilities`)          | its `initialize` answer                                              |
| Other presets (OpenCode, goose, Copilot, Qwen, Auggie, Cline, Kimi, Vibe, Cursor, Kiro) | not checked   | not checked                            | not installed here; decided at run time from each one's `initialize` |
