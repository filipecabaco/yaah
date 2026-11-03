# macOS title bar (2026-11-03)

The standard title bar (a grey strip that said "yaah") is gone on macOS. The traffic lights now sit in the sidebar's top row, beside the logo, "yaah" and Search. Linux keeps its window decorations: the settings below only apply on macOS.

- **Window** (`app/src-tauri/tauri.conf.json`): `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `trafficLightPosition: { x: 16, y: 28 }`. The title stays "yaah" for the Dock, Mission Control and the Window menu.
- **Room for the lights** (`app/src/hooks/use-titlebar.ts`, `sidebar.tsx`): on macOS (Tauri's `isTauri()` and the user agent; `@tauri-apps/plugin-os` isn't a dependency) the top row gets 68 px of left padding, so the logo starts 80 px in. In full screen the lights are hidden, `isFullscreen()` is checked again on each resize, and the padding goes too.
- **Dragging:** the sidebar's top row and the chat header are `data-tauri-drag-region="deep"`. Buttons inside them stay buttons (Tauri skips clickable elements), and the logo is `data-tauri-drag-region="false"`. This needs the `core:window:allow-start-dragging` capability (`capabilities/default.json`). Double-click to zoom uses `internal-toggle-maximize`, which `core:default` already allows.

## Verified on the real app

The app was a debug build (`pnpm tauri build --debug --bundles app`), launched from `target/debug/bundle/macos/yaah.app` with the user's own data. Port 1420 was in use by another dev server, so `tauri dev` couldn't run. Screenshots were taken with `screencapture -l <window id>` (the window id came from `CGWindowListCopyWindowInfo`), and the app was quit afterwards.

| Screenshot | What it shows |
|---|---|
| `first-try-y19.png` | First try, `y: 19`: the lights sat about 9 pt above the row's centre line. With this Tauri, `y` is the inset of the buttons' container, not their top edge. |
| `window.png` | `y: 28`: the lights are centred on the row with the logo and Search, about 10 pt clear of the logo. |
| `search-click-opens-palette.png` | A synthetic click on Search inside the drag row opens the ⌘K palette, so the button still works. |
| `fullscreen.png` | Full screen: no lights, no padding, and the logo back at the edge with no gap. |
| `after-fullscreen.png` | After leaving full screen, the room for the lights is back. |

Dragging was tested with synthetic mouse events (CGEvent, a 120 × 60 pt drag):

- **The top row between the logo and Search:** the window moved from (954, 256) to (1074, 316).
- **The logo:** the window didn't move.
- **The "Agent" label below the row:** the window didn't move (it isn't a drag region).

The traffic lights look grey in these captures because the window wasn't key while it was captured.

The chat header uses the same attribute, but it wasn't captured: this machine had no chats, and starting one would have launched an agent with the user's account.
