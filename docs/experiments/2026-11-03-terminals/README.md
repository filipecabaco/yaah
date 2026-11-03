# Terminals in yaah (3 November 2026)

Terminal panes (a login shell in a PTY), "Open in terminal", and agents' commands shown live in their tool cards
(ACP client terminals), checked in the real macOS app.

**Setup.** A debug build (`cargo build`) against the Vite dev server (`pnpm dev`, port 1420), started with `HOME` set to a
throwaway folder so none of the user's chats, agents or layout were touched. Its only agent profile was the scripted ACP
agent from `src-tauri/tests/acp_e2e` (the test binary in agent mode), whose `terminal-live 45` prompt runs a command
through `terminal/create` that prints for 45 seconds, waits for it and releases it. The UI was driven with keystrokes
through System Events (⌘N, typing, ⌘T); screenshots with `screencapture -l <window id>` (the id from
`CGWindowListCopyWindowInfo`, through `osascript -l JavaScript`). Dark appearance; command cards set to start expanded.
The app was quit afterwards; no shell or agent process outlived it.

| Image                           | What it shows                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `home-new-terminal.png`         | The home screen: **New terminal ⌘T** beside Quick chat and New project.                                                                                                                                                                                      |
| `terminal-pane-beside-chat.png` | ⌘T from the chat: a terminal pane to the right, in the chat's folder, after `ls -la && git status … && echo "hello from yaah"`. On the left, the scripted agent's `cargo test` running in its tool card, streaming live, with **Stop** and **Open as pane**. |
| `tool-card-finished.png`        | The same card once the command exited and was released: `exit 0`, the output kept.                                                                                                                                                                           |
| `restored-after-restart.png`    | After quitting and starting again: the terminal pane opened a new shell in the same folder and says "New shell, the previous session ended when yaah quit."; the tool card replays the bytes kept with the tool call (the terminal itself is gone).          |
| `full-screen-top.png`           | A full-screen program (`top`) in the pane.                                                                                                                                                                                                                   |

## Throughput (xterm.js 6, WebGL renderer, debug Rust build)

Measured in the pane with `zsh/datetime` around each command (`~/bench.zsh`), three runs each, the pane about 95 × 45 cells:

| Output                                                                   | Through the pane        | Same, to /dev/null |
| ------------------------------------------------------------------------ | ----------------------- | ------------------ |
| `cat` of 21 MB (`seq 1 3000000`)                                         | 1.10–1.15 s (≈ 19 MB/s) | 0.005 s            |
| `cat` of a 14 MB build log (100 000 long `Compiling … warning: …` lines) | 0.27–0.29 s             | —                  |
| 300 full-screen redraws (clear + 40 coloured rows each)                  | 0.13 s                  | —                  |

The first build of the pump sent a batch only every 16 ms and let the reader run up to 128 KB ahead, which capped output at
about 4 MB/s (`cat` of 21 MB took 5.1 s, the log 2.1 s, the redraws 0.27 s). It now sends a batch early once 64 KB is
waiting, and the reader waits whenever a view is more than 128 KB unsent or 1 MB unacknowledged behind, so nothing is read
that a view would miss (`a_view_that_keeps_up_misses_nothing_however_fast_the_program`).

## Seen, not fixed

- zsh's partial-line mark (a reverse `%`) shows at the top of a shell opened at a size wider than its pane, as zsh does in
  any terminal resized right after start. Panes now open their shell at the size they will be (a little under), which
  makes it rare.
- Paths under the throwaway `HOME` show in full in the headers, since they aren't under the real home folder.
