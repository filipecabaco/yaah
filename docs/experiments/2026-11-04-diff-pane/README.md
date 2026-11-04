# Diff pane, and open panes in the sidebar

Checked in the browser mock (`pnpm dev` on port 1460, with a fake repository from `src/dev/mock/diff.ts`), yaah light.

1. `01-folder-step-and-sidebar.jpeg`: ⌘K "Open diff…" opened a pane to the right of a terminal. With no folder yet it asks which (a project's repos, chats' folders, or any folder). The sidebar already lists both under "Open panes": the terminal (folder name, shell) and the diff (focused, "no folder yet").
2. `02-diff-beside-terminal.jpeg`: the diff of `web` next to the terminal. Narrow, so the files become tabs. The sidebar row reads "web · 6 changes".
3. `03-wide-diff-sidebar-row.jpeg`: after closing the terminal from its sidebar row's X: files list with status, +/- and viewed ticks, hunks, repo and branch badges, "All changes" select, folder, refresh, open in terminal app, close. The note under it lists untracked files, which git does not diff.
4. `04-against-a-branch.jpeg`: "Against a branch" with its base select (`main`); the range badge shows the base.

Not shown here (covered by `src/components/diff-pane.test.tsx`): the "isn't in a git repository" state, a clean tree, Staged and Unstaged, restore from the saved layout.
