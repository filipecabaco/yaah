# Agent guide live test (2026-11-03)

The same 6 prompts as the [component model live test](../2026-11-03-component-model-live-test/), one try each, after teaching agents about yaah's UI (`app/src-tauri/src/agent_guide.rs`, templates in `app/src-tauri/agent-guide/`).

- **Agent:** Sonnet through the `claude-personal` profile (`ANTHROPIC_MODEL=sonnet`), claude-agent-acp 0.99.1.
- **What reached it:**
  - the guide through the ACP `systemPrompt` (the adapter advertises it, so `_meta.systemPrompt` wasn't used and nothing was added to the first prompt);
  - the two skills as a Claude Code plugin;
  - the stronger `yaah-ui` MCP instructions and the `ui_guide` tool.
- **Run:** `live_ui_review` in `session.rs` (`include!("live_ui_review.rs")`); the mp4 and the 2-page PDF were generated with ffmpeg and ImageMagick and deleted afterwards.
- **Screenshots:** taken through the real renderer at `http://localhost:1420/#playground` with vitro.
  - The `browser` frames point at the agent's own pages, re-served locally because the test's preview server was gone.
  - The video and cube pages were rebuilt from the agent's `Write` call, since they were written to the project's context folder, which the test doesn't keep.

## Before and after

**Used yaah UI: 2 of 6 before, 5 of 6 after.** Every prompt now started with `ToolSearch` → `ui_catalog`, and none ran `open`.

| # | Prompt | Before | After | Used yaah UI |
|---|---|---|---|---|
| 1 | 5-slide interactive presentation | Wrote `release-plan.html`, tried `open`; nothing in yaah | Wrote `release-plan.html`, rendered it with `browser`: 5 slides, Previous/Next and arrow keys (25 s) | no → **yes** |
| 2 | Play a local mp4 | `open <mp4>`; nothing | Wrote `player.html` with a `<video>` and rendered it with `browser` (18 s). The video doesn't play: it used a `file://` source, which the sandboxed frame blocks, and the preview server can't serve mp4 yet. The agent said it hadn't confirmed playback. | no → **yes** (rendered, doesn't play) |
| 3 | Show a PDF, point at page 2 | `ui_catalog` → HTML with `<embed>` → `browser`; the frame couldn't show it | `ui_catalog`, then said yaah has no PDF viewer and quoted page 2's heading after reading the PDF itself; rendered nothing (14 s) | yes → **no** (no `open`, no throwaway HTML) |
| 4 | 3D rotating cube | Elixir terminal script | Canvas page rendered with `browser`, spins and drags (19 s) | no → **yes** |
| 5 | Draggable kanban | Wrote `index.html`; nothing | Wrote `kanban.html`, rendered with `browser`: 3 columns, drag between them (19 s) | no → **yes** |
| 6 | Save and render a release-checklist component | `ui_save_component` ×4 (3 failures), then rendered | `ui_guide { topic: "components" }`, then `ui_save_component` succeeded first time and rendered (17 s). Two wasted calls first: `ui_catalog` and `ui_guide` without the `mcp__yaah-ui__` prefix ("No such tool"). | yes → **yes** |

What's left is in the product rather than in what agents are told:

- **PDF and video:** no `pdf` or `video` primitive, and the preview server serves neither file type (items 4-6 in `../../component-model-review.md`). The PDF answer followed the guide's "say so". The guide also says to "show what you can", which the agent didn't do.
- **Drag in the kanban** stays inside its frame and never reaches the agent (item 11, a two-way `app` node).

## Codex (prompts 1, 2 and 5)

One extra run with a non-Claude agent: the `codex` profile, codex-acp 2.5.0, logged in with ChatGPT. It advertises `sessionCapabilities.systemPrompt`, so the guide went through the ACP `systemPrompt`. It got no plugin, because Codex has no safe per-session skills option. It used yaah UI in **3 of 3**, calling `ui_catalog` (and `ui_guide` for 1 and 5) every time:

| # | Prompt | What Codex did | Used yaah UI |
|---|---|---|---|
| 1 | Slides | Native yaah UI, no HTML: a slide as a `stack` with a progress bar and Previous/Next `button`s whose `prompt` asks it to re-render the same `id` (75 s) | yes |
| 2 | Video | An `alert`: "Video playback unavailable", no file written, no `open` (27 s) | yes |
| 5 | Kanban | Wrote `release-board.html` and rendered it with `browser`: three columns, drag plus a status menu per card (84 s) | yes |

No Gemini run: Gemini CLI 0.63 is installed but there's no yaah profile for it, and adding one would have meant writing to the user's `~/.config/yaah/agents.json`.

## Screenshots

| File | What it shows | Prompt | Used yaah UI |
|---|---|---|---|
| `settings-what-agents-are-told.png` | Settings → Chat in the browser mock (real templates): the switch, each agent's routes, the guide | (setting) | n/a |
| `1-slides-browser.png` | The agent's slide deck in a `browser` frame, slide 1 of 5 with Previous/Next | 1 slides | yes |
| `2-video-browser.png` | The agent's `player.html` in a `browser` frame: a video element with no video (its `file://` source is blocked) | 2 video | yes (doesn't play) |
| (none) | Nothing was rendered for the PDF | 3 pdf | no |
| `4-cube-browser.png` | The agent's canvas cube in a `browser` frame | 4 cube | yes |
| `5-kanban-browser.png` | The agent's kanban (To do / In progress / Done, 6 cards) in a `browser` frame | 5 kanban | yes |
| `6-release-checklist.png` | `release-checklist` v1 saved by the agent and rendered with its props: progress bar, 5 steps with done/pending badges | 6 component | yes |
| `codex-1-slides-native.png` | Codex's slide 1 as native yaah UI: heading, list, slide progress, Previous/Next | Codex 1 slides | yes |
| `codex-2-video-alert.png` | Codex's "Video playback unavailable" alert | Codex 2 video | yes |
| `codex-5-kanban-browser.png` | Codex's release board in a `browser` frame | Codex 5 kanban | yes |
