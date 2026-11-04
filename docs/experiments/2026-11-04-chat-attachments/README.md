# Chat attachments and agents' images (2026-11-04)

Dropping, pasting and picking images, files and folders into a chat, and images agents send back (browser screenshots in tool results) shown in the transcript. Shot with vitro against `pnpm dev` (the browser mock) on port 1463, 1280 × 800, yaah light.

The mock turns a drag from the OS into the Tauri drag-drop events the app listens to, with made-up paths under `~/Downloads`. Scripts call `window.__yaahMock.dragFiles(files, x, y)`, `dropFiles(...)` and `leave()` to do the same. A name containing `huge` is refused, `wide`/`panorama` is reported as downscaled, and the Attach button's picker returns `~/Downloads/mockup.png` and `~/workspace/shop/README.md`. A prompt mentioning "screenshot" or "browser" replays `screenshotChat` (`src/dev/mock/attachments.ts`): navigate, screenshot, click, screenshot, the way claude-agent-acp reports vitro or Playwright MCP calls.

| Shot                              | What it shows                                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-drop-overlay.png`             | Two images and a Markdown file dragged over the chat pane. The overlay says what will happen and what Claude takes: images as images, small text files inline, other files as file references. |
| `02-chips-and-refusal.png`        | After the drop: chips above the textarea (thumbnails, file and folder icons, size, a note for the downscaled panorama, a remove button on each) and the refusal for an 82 MB image.            |
| `03-sent-message.png`             | The sent message: image thumbnails above the text, the file and folder as chips.                                                                                                               |
| `04-screenshots-folded-group.png` | The screenshot chat with tool calls grouped. The folded group row keeps its two screenshots in a strip under it.                                                                               |
| `05-screenshots-in-cards.png`     | The same group opened. Each screenshot sits under its card's title, visible whether the card is open or not.                                                                                   |
| `06-large-view.png`               | A screenshot opened in the large view (click or Enter), titled by its tool call, with its size and format.                                                                                     |

## Why the strip sits under the group row

A folded group is one quiet line, by design. Thumbnails inside that line would make it as tall as they are and push the summary aside. A row of thumbnails directly under it, indented to the summary text, reads as the group's output. Keyboard order stays natural (the row, then its images). The strip shows the latest four images, with "+N more inside" past that, and it goes away when the group is opened, since the cards then show their own.
