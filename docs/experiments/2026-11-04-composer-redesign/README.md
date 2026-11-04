# The composer as one control (2026-11-04)

The chat's composer redesigned from five loose pieces into one frame. Shot with vitro against `pnpm dev` (the browser
mock) on port 1443, with HMR off and its own Vite cache dir (a throwaway config outside the repo), because other agents
were editing the tree. 1440 × 900 unless noted. Narrow panes are the window at 650 and 570 px, which leaves a chat pane of
about 360 and 280 px next to the sidebar. Files were dropped with `window.__yaahMock.dropFiles` (a name containing `huge`
is refused). The running turn is the mock's permission chat, which waits on its card.

## Before

| Shot                       | What it shows                                                                                                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before-01-everything.png` | Five loose pieces: chips above, the paperclip outside on the left, Send outside on the right, an "Attaches" row and a Model/Effort row below. A 4px dark focus border on the textarea, and the refusal's × far to the right. |
| `before-02-narrow.png`     | The same at about 360 px. The textarea is squeezed between the paperclip and Send, and the placeholder (a help page) no longer fits.                                                                                         |

The earlier shots in `2026-11-04-model-effort/01-composer-row.png`, `2026-11-04-hash-references/03-picked-token-and-chips.png`
and `2026-11-04-chat-attachments/02-chips-and-refusal.png` show the same layout.

## After

| Shot                                   | What it shows                                                                                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-empty-focused.png`                 | An empty chat, focused. One frame: the message box, then a toolbar with Attach, "Model Default (recommended)", "Effort Default", the trigger keys and Send. Focus is a 2px line in `--ring`. |
| `02-typing.png`                        | Four lines of a list: the message box grows inside the frame, and the toolbar stays under it.                                                                                                |
| `03-suggestions-above.png`             | `#212`: the reference list opens just above the frame, aligned with its left edge.                                                                                                           |
| `04-reference-chip.png`                | The token picked. Its chip is at the top of the frame (id, title), shaped like an attachment chip. No separate "Attaches" row.                                                               |
| `05-attachments-refusal-reference.png` | Two images and a file dropped, plus one refused. The attachment and reference chips share one row, and the refusal sits under them with its × right after the message.                       |
| `06-model-picker-open.png`             | The Model picker open from the toolbar (the same popover and list as before). The frame shows no focus line while the list has the focus.                                                    |
| `07-running-stop-locked.png`           | A turn running (a permission card waiting). Stop replaces Send, and Model and Effort are disabled.                                                                                           |
| `08-narrow-360.png`                    | About 360 px: the chips wrap, the trigger keys and the chevrons go, the model's name truncates, and "Effort Default" stays whole.                                                            |
| `09-narrow-280.png`                    | 280 px, the narrowest pane: chips fit the frame's width, and both labels stay, though the model's value is down to its first letter (the full one is in the label and tooltip).              |
| `10-dark-focused.png`                  | yaah dark, focused.                                                                                                                                                                          |
| `11-dark-at-rest.png`                  | yaah dark, not focused: the frame is the theme's `--input` border.                                                                                                                           |
| `12-tokyo-night-focused.png`           | Tokyo Night, focused: the ring is the theme's floored accent.                                                                                                                                |

## Decisions

- **One frame.** `components/composer-shell.tsx` draws a rounded-xl border in `--input` around three parts: a top
  part for chips (laid out only when there are any), the textarea, and a toolbar. The textarea loses its own border,
  ring and fill. Behaviour (keys, the suggestion list, sending) stays in `chat.tsx`. The starting-chat composer uses the
  same frame, so nothing jumps when the chat opens.
- **Focus on the frame, quieter.** Before: a 1px `--ring` border plus a 3px solid `--ring` halo on the textarea (index.css
  makes every focus halo solid for FO-1), so about 4px of dark gray. After: a 1px `--ring` border plus a 1px `--ring`
  ring on the frame, so 2px. It is drawn only while the textarea itself has focus (`has-[[data-composer]:focus-visible]`).
  A toolbar button with focus shows its own ring and leaves the frame alone.
- **Contrast.** The focus line is `--ring`. FO-1 in `theme-contrast.test.ts` keeps it at 3:1 or more on the page in all
  65 themes: about 3.95:1 in yaah light, 4.2:1 in yaah dark and 4.5:1 in Tokyo Night (computed from the live tokens). The
  frame at rest is `--input`, which FO-2 keeps at 3:1 in light themes. In dark themes it is the theme's own border, as for
  every field. The frame has the page's own background, not the `dark:bg-input/30` fill of a stock field. With that fill,
  destructive text (a refusal) fell to 3.92:1 in Dracula, 3.79:1 in Dracula Soft and 4.14:1 in Night Owl. This was
  measured by adding a `field` surface to TH-2, which then failed, so the fill was dropped and the check reverted.
- **Model and Effort say which is which.** Each trigger shows its name in muted text and then the value ("Model Default
  (recommended)", "Effort Default"). The Cpu and Gauge icons are gone. The accessible names and the tooltips are
  unchanged. In a narrow pane the model's value truncates and the effort level, one word, stays whole. The chevrons go
  below 24 rem of pane.
- **A short placeholder.** "Message Claude…" fits any pane. The triggers moved to the toolbar as keys (`/` commands, `@`
  files, `#` issues and PRs). The words show from 42 rem of pane, the keys alone from 28 rem, and nothing below that.
  That hint is `aria-hidden`. Screen readers get the same help, plus Enter and Shift+Enter, as the textarea's
  `aria-describedby`.
- **One row of chips.** Reference chips now look like attachment chips (icon, id, title), so "what this message carries"
  is one row. Chips on a line share its height. A refusal's dismiss sits right after its text.
- **Press anywhere in the frame.** A mousedown on the frame's empty space (padding, the toolbar's gap) focuses the textarea.
  Controls, chips and the refusal keep their own clicks.
- **Motion.** Only the border and ring colours transition, over 150 ms, and `motion-reduce:transition-none` turns that off.

## Where the queue goes

The queued-messages list (`components/composer-queue.tsx`, another change) renders as its own element between the
transcript and the composer. The composer no longer draws a top border, so the queue's own `border-t` is the only line
between the transcript and the queue, and the frame sits right under the queue.
