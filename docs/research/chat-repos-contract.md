# Adding repositories to a chat as you go (contract)

Branch `feat/split-panes-collapsible-sidebar`.

## Behaviour
- **Project chat:** adding repos adds them to the **project** (`projects.rs`), so this chat and every later chat in the project
  get them. Other chats of the project that are open pick them up on their next prompt.
- **Quick chat:** adding repos adds them to **that chat only**, as extra context folders persisted on the chat.
- **The running agent** gets the new folders from the next prompt on.
  - If the agent can load sessions (`loadSession`), yaah reloads the ACP session before that prompt with `session/load`,
    passing the updated `additionalDirectories` (and everything else it passes today).
  - Otherwise it starts a fresh session with the same hand-off the agent switch uses.
- **Transcript notice:** a small entry, "Added `name` to this project" / "Added `name` to this chat", with the paths.
- **Validation:** paths must exist and be directories; duplicates are ignored; the chat's own cwd is never added twice.

## Commands (camelCase JSON, async)
- `add_chat_dirs({ sessionId, paths: string[] }) -> SessionInfo`. Returns the updated info. Refused mid-turn (it applies after the turn
  ends) only if reloading mid-turn is unsafe; otherwise queue it for the next prompt.
- `new_quick_chat({ accountId, dir?, extraDirs?: string[] })` and `new_session({ projectId, accountId, extraDirs?: string[] })` accept
  repos chosen up front. For a project, extra dirs chosen at creation also join the project.
- `SessionInfo` gains `extraDirs: string[]` (quick chats; empty for project chats, whose folders come from the project).

## UI
- An "Add repositories…" command in ⌘K when a chat is focused, and a yaah-local `/repos` slash command.
- The chat header shows the chat's folders (a count and a menu listing them, with "Add repositories…").
- All of these open the existing `RepoPicker` (`repo-picker.tsx`: keyboard list, clone, browse) in "add to this chat" mode.
- The split-pane new-chat picker has an optional "Repositories" step (the same `RepoPicker`) whose result goes to `extraDirs`.

## The agent asking for folders (`ui_request_folders`)
- A yaah UI MCP tool, `ui_request_folders({ paths, reason })`. Paths must exist and be folders (absolute or `~/…`; canonical,
  once each, at most 10). Ones the chat already has are left out; with none left it answers at once, nothing shown.
- It shows an inline card (`Entry::FolderRequest`): "The agent wants to add `~/…` to this chat", the reason, **Add** / **Not now**.
  The tool call waits like `ui_ask`; stopping the turn cancels it.
- **Add** (`answer_folder_request({ sessionId, index, add })`) goes through `add_chat_dirs`'s flow (project or chat, the
  notice after the turn), then tells the agent to read it with `repo`. If adding fails, the card stays open.
- **Not now** adds nothing; the agent is told not to ask again or look for the folder with shell commands.
- It needs no permission prompt (it's in Claude Code's `allowedTools`): the card is the prompt.
