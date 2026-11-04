# Palette scopes: chats first, `@` and `#`

Checked in the browser mock (`pnpm dev`, port 5188), yaah light.

1. `1-empty-query-order.png`: ⌘K with an empty query lists Chats, then Projects, then Commands. The input's placeholder says "@ chats and projects · # commands".
2. `2-at-scope.png`: typing `@` turns into a "Chats and projects" chip; only chats and projects are listed. Backspace on the empty query removes the chip.
3. `3-hash-scope.png`: `#` then `sp` in the "Commands" scope; only commands, fuzzy-ranked.

Ranking while searching: groups go chats, projects, commands, each group's best score weighted (chats x1.5, projects x1.25, commands x1), so commands lead only when they beat the best chat match by half again.

In the palette `@` means chats and projects and `#` means commands. In the composer `@` is files and `#` is tracker references.
