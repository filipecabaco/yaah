# Website refresh for 0.5.0 and 0.5.1 (2026-11-04)

New and replaced screenshots for `site/` and the root `README.md`, and the checks of the built site. Follows
`2026-11-03-website/`, which has the first set.

**App screenshots** (`raw/`): vitro against the browser mock (`pnpm exec vite --port 1489 --strictPort` in `app/`), at
1440×900 and device scale factor 2. Light and dark are the app's yaah light and yaah dark, switched by emulating the system
colour scheme (the mock's appearance is System); each pair is the same state captured twice, with a 2 s pause after the
switch so the theme transition has settled. The site uses crops of these, resized with ImageMagick (Lanczos) and encoded
with `cwebp -q 86 -m 6` into `site/public/shots/<name>-light.webp` and `-dark.webp`, at the widths the earlier shots use
(1600 for full windows, 1200 for chat crops, 1400 for Settings, 900 for the palette, 800 for the pane picker).

| Name | What it shows | How it was set up | Where |
|---|---|---|---|
| `map-connection` (new) | `connection` map: flights between 12 hubs as great circles | quick chat, "Show me the map types" | Charts, maps and flow graphs; README hero |
| `flow-network` (new) | `flow` network: 15 services in 3 tiers | quick chat, "Show me the flow graphs" | Charts, maps and flow graphs |
| `composer-references` (new) | Message box: two images and a file dropped (`__yaahMock.dropFiles`), `#webhook` list, GitLab's revoked-token line, Model and Effort | new chat in "billing revamp" | The message box; README |
| `composer` (new) | Message box with the attachments, the `acme/api#212` reference chip, the token in the text, the toolbar | same chat, `#212` then Tab | The message box |
| `diff-pane` (new) | Diff pane beside the project chat, listed under the project in the sidebar | ⌘K "Diff of this folder" from "triage ENG-142", divider moved to 38% | Split panes, terminals and diffs |
| `chat-images` (new) | Two browser screenshots under a folded group of four tool calls | quick chat, a prompt with "screenshot" (`screenshotChat`) | A calmer chat |
| `permission` (replaced) | Permission card in a project chat: In this chat, In this project, In all chats | "triage ENG-142" in "billing revamp" | Permissions |
| `palette` (replaced) | ⌘K with nothing typed: chats, projects, commands; the `@` / `#` placeholder | ⌘K | Keyboard first |
| `pack-system-monitor` (replaced) | Hero: system-monitor with the new message box | quick chat, the pack prompt, permissions answered Yes | Hero; README |
| `split-panes` (replaced) | Project chat, terminal (listed under the project) and the project page | "triage ENG-142" (Linear trusted in the project, `rm -rf build` denied), ⌘T, ⌘⇧D, the project | Split panes; README |
| `settings-fonts` (replaced) | Fonts with linked sizes and the ⌘= / ⌘- note | ⌘, → General | Fonts and sizes |
| `pane-picker` (replaced) | A new pane's picker, now with Open diff… | quick chat, ⌘D | Resume a session |

Notes:

- The mock's terminal only runs `echo` and `exit`, and extra Enter presses left blank prompts in `split-panes`.
- The hero's chart starts with a gap of about 1.5 minutes (the first sample was taken before the permissions were answered).
- In `split-panes-dark` the project name field shows its hover fill; the pointer was over it.
- Opening Settings once froze the page for a while (Chrome stopped answering evaluate); a reload and ⌘, worked.
  Not investigated.

**Site checks** (`verify/`): `pnpm build`, served with `pnpm astro preview --port 4391`, every image forced to load
and decoded. No broken images, no element wider than the viewport outside scrollable code and tables, and the dark theme
swaps every screenshot to its `-dark` file (30 visible, 0 light). Lighthouse (vitro's `run_audit`, its default mobile
emulation, cold cache): accessibility 100, best practices 100, SEO 100, performance 100.

| File | Width | Theme |
|---|---|---|
| `verify/site-1440-light-full.jpg` | 1440 | light |
| `verify/site-1440-dark-full.jpg` | 1440 | dark |
| `verify/site-0400-light-full.jpg` | 400 | light |
| `verify/site-0400-dark-full.jpg` | 400 | dark |
