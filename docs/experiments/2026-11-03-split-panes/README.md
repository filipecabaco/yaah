# Split panes and the hideable, resizable sidebar (2026-11-03)

Branch `feat/split-panes-collapsible-sidebar`. Browser shots are vitro on the dev mock (`pnpm dev`, http://localhost:1420);
the real-app shots are a debug build of yaah on macOS (`cargo build --no-default-features`, run against the same Vite
server), captured with `screencapture -l <window id>` at 2x.

## What was built

- **Split panes, Ghostty-style.** ⌘D splits the focused pane to the right, ⌘⇧D downward; panes nest as a tree. ⌘⌥ + an
  arrow moves to the neighbouring pane, ⌘W closes the focused one (never the last; there it closes the Component library,
  as Esc does). Clicking a pane focuses it. With more than one pane the focused one has a subtle inset ring.
- **A new pane opens on a picker**: New chat (with the agent picked under it, and an optional "Add repositories…" step that
  opens the RepoPicker; the paths go to `new_quick_chat` as `extraDirs`), New project…, then recent chats and projects. One
  fuzzy search over all of it, ranked like ⌘K. Arrows and Enter; Esc clears the search, then closes the pane.
- **Each pane is its own**: chat, streaming, scroll position, composer draft. The sidebar highlights what the focused pane
  shows and opens into it; ⌘N, ⌘L, ⌘., ⌘[ ⌘], ⌘1–9 and the palette act on it; drafts from diffs, menus and agent UI land
  in the composer of the pane they came from.
- **The same chat in two panes** is allowed: both follow the same transcript store, each with its own composer and scroll.
- **Dividers** drag (min 280 × 160 px per pane), take arrow keys (Shift: further), Home/End, and double-click evens them.
  `role="separator"` with `aria-orientation` and `aria-valuenow`.
- **Remembered**: the tree, each pane's content and the ratios go to `settings.json` (`layout`) through `settings.rs`;
  `layout.rs` checks what's saved and drops panes whose chat or project is gone when the app starts.
- **The sidebar** resizes from its right edge (220–480 px, arrows, double-click resets to 288) and hides with ⌘B (also its
  button and ⌘K "Hide sidebar"). Hidden, it slides to nothing (width animates, `motion-reduce` respected) and the main
  area's top row becomes the title bar: on macOS an 80 px gutter for the traffic lights, then Show sidebar, the logo and
  Search ⌘K, 52 px tall like the sidebar's first row so the lights sit centred in it; it drags the window. Shown, the
  sidebar's first row is the logo with Hide pinned inside the right edge, and Search ⌘K has its own full-width row.

## Browser (dev mock)

| file | what |
| --- | --- |
| [01-three-panes-light-1440.png](01-three-panes-light-1440.png) | A chat waiting on a permission, a second chat, a project below it; the focused pane ringed, the sidebar highlighting it |
| [02-three-panes-dark-1920.png](02-three-panes-dark-1920.png) | The same in dark at 1920 |
| [03-picker-in-a-fourth-pane-dark-1920.png](03-picker-in-a-fourth-pane-dark-1920.png) | ⌘D on the project pane: the picker (Start, Recent chats, Projects, the agent for new chats) |
| [04-sidebar-hidden-four-panes-dark-1920.png](04-sidebar-hidden-four-panes-dark-1920.png) | ⌘B: no strip, the title bar above the panes |
| [05-picker-search-light-1440.png](05-picker-search-light-1440.png) | Four panes, sidebar at its 220 px minimum, the picker searching "li" (a project and a chat ranked together) |
| [06-sidebar-at-220px-four-panes-repos-chosen-dark-1440.png](06-sidebar-at-220px-four-panes-repos-chosen-dark-1440.png) | The picker in a 280 px pane after choosing two repositories: labels truncate, details give way first |
| [07a-hiding-mid-transition-light-1440.png](07a-hiding-mid-transition-light-1440.png) | Caught mid-animation: the sidebar sliding away while the title bar grows in |
| [07-sidebar-hidden-title-bar-light-1440.png](07-sidebar-hidden-title-bar-light-1440.png) | Hidden, light: Show sidebar, logo, Search ⌘K |
| [08-narrow-sidebar-picker-light-1920.png](08-narrow-sidebar-picker-light-1920.png) | Light 1920 with the sidebar at 220 px |
| [09-picker-repositories-step-light-1920.png](09-picker-repositories-step-light-1920.png) | "Add repositories…" done: "New chat · with Claude · 2 repos" and the chosen repos, each removable |
| [10-split-down-sidebar-hidden-dark-1440.png](10-split-down-sidebar-hidden-dark-1440.png) | Dark 1440, sidebar hidden, four panes |

## Real app (macOS, traffic lights)

| file | what |
| --- | --- |
| [11-real-app-hidden-dark.png](11-real-app-hidden-dark.png) | Hidden, one pane: the lights in their corner, Show sidebar, logo and Search after the 80 px gutter, all on the lights' row |
| [12-real-app-hidden-split-dark.png](12-real-app-hidden-split-dark.png) | Hidden, three panes (⌘D then ⌘⇧D) |
| [13-real-app-shown-288px-split-dark.png](13-real-app-shown-288px-split-dark.png) | Shown at the default 288 px, after ⌘W closed a pane: the first row is lights, logo, and Hide inside the edge; Search below |
| [14-real-app-shown-220px-light.png](14-real-app-shown-220px-light.png) | The 220 px minimum: nothing overflows; Chats "+" and its chevron stay inside |
| [15-real-app-shown-480px-light.png](15-real-app-shown-480px-light.png) | The 480 px maximum, with the picker pane at its narrowest |
| [16-real-app-hidden-split-light.png](16-real-app-hidden-split-light.png) | Hidden, two panes, light (window not key, so the lights are drawn inactive and faint) |
| [17-real-app-shown-one-pane-light.png](17-real-app-shown-one-pane-light.png) | Shown, one pane: today's layout |
| [18-real-app-hidden-one-pane-light.png](18-real-app-hidden-one-pane-light.png) | Hidden, one pane, light |

## Findings

- **⌘W in the real app** closes the pane, not the window: WebKit hands the key to the page first, and the shortcut's
  `preventDefault` keeps the menu's Close Window from firing. No menu change was needed. On the last pane ⌘W does nothing
  (or closes the library), so it never closes the window; the red light still does.
- **First design of the hidden sidebar** was a 76 px strip with the logo and an expand button under the lights. It left the
  third light overhanging the strip's edge and most of the strip empty, so it was replaced by the title-bar row above.
- **The first top row** put Search ⌘K and Hide beside the logo, which pushed Hide past the sidebar's edge on macOS. Search
  now has its own row.
- In a browser, ⌘W can't be taken from the browser (it closes the tab), so the browser checks used the palette's
  "Close pane"; the vitest suite drives ⌘W as a key.
- vitro's `press_key` sends the key's character as a separate event after `keydown`, so pressing Enter on the picker's
  "New chat" left a newline in the new chat's composer in the browser check. A real keypress doesn't: the picker's Enter
  is `preventDefault`ed by cmdk on `keydown`.
- Linux: Ctrl+Alt+arrows are GNOME's workspace switcher, so moving between panes by keyboard may be taken by the window
  manager there; the palette's "Focus next pane" and clicking still work.
