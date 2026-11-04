# Expand fills the dialog (2026-11-04)

Agent-rendered UI in the Expand dialog now gives its main scroll area the whole height
(`growClass` / `growAttr` in `app/src/components/ui-view.ts`, plus the `:has([data-grow])` rule on
the `UiTree` root). Checked on `pnpm dev` (port 1447, browser mock) at 1440x900 with vitro, via a
dev-only mock prompt, `expand fill` (`app/src/dev/mock/chats.ts`), which shows six library
components in one chat.

| Screenshot | What it shows |
|---|---|
| `file-view-mdx-before-light.jpg` | The bug: a rendered `.mdx` file in a capped box (`max-h-[560px]`), half the dialog empty. Reproduced by putting the old classes back on the body in the DOM. |
| `file-view-mdx-after-light.jpg` | After: the body fills the dialog and scrolls inside itself. |
| `file-view-source-after-light.jpg` | file-view on source (line numbers, find): fills. |
| `container-logs-after-dark.jpg` | card > live > textfile: the log fills the dialog, footer keeps its size. |
| `git-graph-after-dark.jpg` | Short list: natural height, top-aligned (`fit`), no empty stretched box. |
| `test-report-after-dark.jpg` | No scroll area: natural height, top-aligned. |
| `db-query-after-dark.jpg` | Chart plus table: natural height, top-aligned. |

Measured in each dialog: the growing region's height is about the slot's height minus its
siblings, and the slot's `scrollHeight` equals its `clientHeight`, so nothing scrolls twice.
Dark and light were both checked (the "before" and the mdx/source "after" are light, the rest dark).
