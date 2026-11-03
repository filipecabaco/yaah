# Creating projects and quick chats (2026-11-03)

Three changes to how work starts: the agent is chosen when a project or quick chat is created, the Add repos list is driven from its search box, and a project made from folders can start with a statement of work.

## Choosing the agent

- **Projects** keep an `agentId` (`app/src-tauri/src/projects.rs`; optional, so registries from before load with none, and none is never written as `null`). The New project dialog has an Agent select in both modes, set to the sidebar's agent each time it opens. "From an issue" passes it to `start_project_from_item`, and `work_items::start` records it on the project it creates.
- **The project page** has the same select beside Status (`set_project_agent`, checked against the saved agents). New chat, ⌘N, the sidebar's project menu and ⌘K use the project's agent, falling back to the sidebar's when the project has none or its agent was removed (`useYaah().agentFor`). The arrow next to "New chat as …" starts one chat with another agent and leaves the project's agent as it is.
- **Quick chats**: the arrow next to the sidebar's Chats "+" and next to the home screen's Quick chat opens "Quick chat with…", where the current agent shows ⌘N. The Chats context menu has a "Quick chat with" submenu, and ⌘K has "New quick chat with…". ⌘N still uses the sidebar's agent. An agent that isn't logged in opens its login instead. The chat keeps the agent it started with (`SessionInfo.accountId`, as before).

## Add repos from the keyboard

The bug: when the picker opened, Radix's dialog moved focus to its first button (the header's "add folder"), not the search box, so typing and the arrow keys went nowhere until you clicked into the search. The highlight was also hard to see (`bg-muted`, the same grey as the hover).

Now focus starts in the search, and the list is a listbox the search controls (`aria-activedescendant`, `aria-controls`, a key legend as its description):

- ↓/↑ move the highlight, skip repos already added, stop at the ends and keep the row in view.
- Space or Enter ticks the highlighted repo. Enter with exactly one match adds it, and ⌘/Ctrl+Enter adds the selection (or the highlighted repo when nothing is ticked).
- Esc closes only the picker. Typing filters and puts the highlight back on the first match, and hovering moves it.

This also fixes a bug found along the way: React passes `submit` events up through portals, so Clone inside the New project dialog also submitted that dialog's form and created a project. The picker now sits outside the form and its Clone form stops the event. A test checks this, and it fails without the fix.

## Statement of work

"Name and repos" has an optional Markdown textarea with a hint: what's the goal, what's in and out of scope, and what "done" means. ⌘/Ctrl+Enter in it creates the project. Rust writes it into `project.md` (`projects::initial_brief`) as `# Name`, then `## Statement of work`, then the text. It's edited afterwards in the project page's Brief, like the rest of the brief.

## Screenshots

These come from the dev mock (`pnpm dev`, http://localhost:1430, in a worktree holding only these changes), driven with vitro.

| Screenshot | What it shows |
|---|---|
| `00-before-repo-picker.jpg` | Before: "a" typed and ↓ pressed after clicking into the search. The highlighted row (api-billing) is hard to see, and on open focus had been on "add folder". |
| `01-home-quick-chat-with.png` | The home screen's split button: "Quick chat with…", with ⌘N on the current agent. |
| `02-sidebar-quick-chat-with.png` | The same menu from the sidebar's Chats header. |
| `03-new-project-agent-select.png` | New project: the Agent select open, the current agent ticked. |
| `04-add-repos-keyboard.png` | Add repos after typing "a", ↓, Space, ↓↓, Space: two repos ticked, the highlight on docs, the search still "a", and the key legend. |
| `05-new-project-filled.png` | The dialog after ⌘↵ added them: Claude (work), two repos, a statement of work. |
| `06-project-page-agent-and-brief.png` | The new project: its agent beside Status, "New chat as Claude (work)" with its "New chat with…" menu (the project's agent marked), and the brief with the statement under its heading. |
| `07-palette-quick-chat-with.png` | ⌘K → "New quick chat with…". |
