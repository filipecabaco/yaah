# Browser pane: what vitro changes

Date: 2026-11-04. Research only; nothing in `app/` or in the vitro repo was changed. A throwaway spike was run outside both repos (see "What the spike measured"). Follows [browser-pane.md](browser-pane.md); read its option table first.

## Short version

- The idea works in outline and is cheaper than CEF: **yaah owns a real Chrome, launched over `--remote-debugging-pipe` in a yaah-owned profile, and draws it in the pane from `Page.startScreencast` frames, with mouse and keyboard sent back as `Input.*` events.** No Tauri child webview (so no z-order bug, no Linux placement bug), no Tauri 3 alpha, no 170 MB runtime. Cost: Chrome must be installed (or downloaded).
- **vitro proves half of it.** It proves the Chrome launch, the pipe transport, orphan-proof shutdown, a demand-driven screencast and the supervision/safety model. It does **not** prove the interactive half: its window is view-only and never sends input to the page. It also cannot host extensions as built, because each session is a `Target.createBrowserContext`, and I measured that extensions do not run in such a context.
- A spike I ran with Chrome 157 shows the Chrome side of the idea is sound: `Extensions.loadUnpacked` works, a content-script overlay (the shape of 1Password's inline menu) is captured by the screencast, `chrome.action.openPopup()` creates a capturable page target, and screencast runs at 60 fps. What it did not test: a real 1Password install, the desktop-app handshake, and a human-driven input loop in a real UI.
- **Recommendation:** replace "child webview MVP first" with a **Chrome-over-CDP docked pane** on both macOS and Linux, with the extension phase using the same architecture rather than a second engine. Keep the child-webview/CEF material in browser-pane.md as fallbacks. Do not make yaah depend on a running vitro; reuse vitro's ideas and a few hundred lines of its CDP knowledge, re-implemented in Rust. Let the agent drive the same Chrome through yaah's own `browser_*` tools, not through vitro sessions.

## 1. How vitro launches and shows Chrome

**Discovery.** `Vitro.Chrome.resolve/0` tries, in order: `VITRO_CHROME`, `chrome-headless-shell` (when headless), a pinned download in `priv/chrome/`, a Chrome for Testing cache from Puppeteer/Playwright, then fixed system paths for Google Chrome and Chromium on macOS and Linux (`vitro-lib/lib/vitro/chrome.ex:72-96`, paths at `:15-20`). It does not look for Brave or Edge. The pinned download is never started automatically (README.md, "Open risks").

**Launch.** Chrome is started through `/bin/sh` with `exec 3<&0 4>&1 1>&2; exec <chrome> --remote-debugging-pipe ...` so Chrome's fd 3/4 become the Erlang port's stdin/stdout; messages are NUL-delimited JSON (`vitro-lib/lib/vitro/cdp/connection.ex:1-30`, spawn at about `:340`). Pipe instead of port is deliberate: no TCP port for another local process to hijack, and when the owner dies Chrome sees EOF and exits, so there are no orphans (`chrome.ex:98-106`, `connection.ex:22-30`). Only the audit slot uses a port (`chrome.ex:109-116`). A `Vitro.Reaper` also kills browsers whose `--user-data-dir=<tmp>/vitro-*` has no live owner (`reaper.ex:1-60`). The environment is allow-listed so Chrome does not inherit the host's secrets (`chrome.ex:22-34`).

**Flags worth copying or avoiding** (`chrome.ex:118-166`): `--no-first-run`, `--no-default-browser-check`, `--disable-background-networking`, one combined `--disable-features=...` (Chrome reads only one), `--process-per-site`, `--mute-audio`, `--password-store=basic`, `--use-mock-keychain`, `--disable-breakpad`. `--password-store=basic` and the mock keychain are right for a throwaway fleet and wrong for a user's profile: they stop Chrome using the OS keychain, which matters for saved logins and for anything that wraps secrets in it. yaah's profile should not copy those two.

**Profiles and persistence.** The default profile is a fresh 0700 temp directory per Chrome (`connection.ex:~300-312`, `private.ex`); a `user_data_dir` option exists but the fleet does not use it. "Contexts that outlive the process" is not a persistent Chrome profile. A session is a BrowserContext in a shared browser; on idle it is written out (pages, cookies, storage, journal position) to `resume.json` and rebuilt by `resume_session` (`history.ex:59`, `:254`; README.md "Stalling"). Quitting the app ends all sessions. So vitro has no precedent for a long-lived, user-owned profile.

**Headless versus headed.** Default is `--headless=new` with `chrome-headless-shell` (half the memory: 2,964 MB against 5,934 MB for twelve sessions, README.md "Which browser it launches"). Headed is `VITRO_HEADED=1`, fleet-wide, read at start (`chrome.ex:160-166`, `:256-268`). The README says to poke at a vitro page by hand by running headed, not by attaching a second CDP client, because a second client fights over `Emulation` and `Tracing` overrides.

**Crash recovery.** A browser that dies within a launch window is relaunched up to 3 times with backoff; after that its sessions are marked dead (`connection.ex:426-460`, `@max_launch_attempts` at `:73`). Known flake: SIGTRAP at startup on Chrome for Testing 146 / macOS 26 when launched in quick succession (README.md "Open risks"). Idle browsers are shut down after 5 minutes to save 75-677 MB (`connection.ex:35-48`).

**How a person sees it.** Not a native window. `Page.startScreencast` frames go Chrome, then a per-page `Vitro.Screencast` GenServer, then one WebSocket per pane, then a `<img>` whose `src` is a blob URL per frame:
- Parameters: PNG by default (JPEG on request), `maxWidth 1440`, `maxHeight 900`, `everyNthFrame 2` (`vitro-lib/lib/vitro/screencast.ex:~259-270`, format at `:~400-420`). `quality` is ignored for PNG. The code must ack every frame with `Page.screencastFrameAck` (`:~480`).
- Demand-driven: cast starts on first watcher and stops on last; the README sets the target at roughly 2 fps for thumbnails and 10 fps for the focused pane (README.md "Supervision UI"). The first watcher gets a `Page.captureScreenshot` because a screencast only emits on repaint and a static page would otherwise show blank (`screencast.ex:~277`).
- Bytes are retained for a replay scrubber, capped by byte size (about 6 MB per page, `screencast.ex:~35`).
- UI side: `vitro-desktop/lib/vitro/ui.ex:~1287-1330` (blob per frame, revoked on swap).

**What the window does not do.** The control channel accepts only `watch`, `unwatch` and `status` (`ui.ex:148-175`). A search for `Input.dispatch*` finds it only in the agent actuation code (`vitro-lib/lib/vitro/browser/cdp.ex:1233`, `:1399`, `:1559-1570`), never in the UI path. The window cannot click, type, scroll, paste or drag into a page. There is no multi-tab strip, no popup or `window.open` handling, no file-chooser or permission-prompt handling, and device scale factor is pinned to 1 (`cdp.ex:375`, `:536`). `handle_dialog` for JS dialogs is an agent tool (`cdp.ex:852`), not UI. The README names "Screencast CPU at scale" as designed, not measured.

So vitro is evidence for "screencast pipeline plus lifecycle", and for nothing about input, IME, clipboard, drag, tabs or popups.

## 2. The docked-pane idea

### What is established

From vitro: pipe launch, screencast with ack, throttle by demand, prime with a screenshot, retain nothing you do not need, orphan-proof shutdown.

From the spike (below), on macOS with branded Chrome 157.0.8103.39, `--headless=new`, `--remote-debugging-pipe`, `--enable-unsafe-extension-debugging`:
- `Extensions.loadUnpacked` returns an extension id. Branded Chrome has dropped `--load-extension` since 137 (from memory, unverified here), but this CDP route works.
- A content script that appends a high z-index `div` to the page (the shape of an inline autofill menu) is in the page and in the screencast.
- Extension service workers appear as targets; from one, `chrome.action.openPopup()` resolved and a `page` target with the popup URL appeared. Popups are therefore real targets that can be attached to and screencast (a popup opened as an ordinary tab also produced a frame).
- Screencast on a full-viewport animated canvas (worst case) ran at about 60 fps: JPEG q70 about 1.6 MB/s, PNG about 3.5 MB/s; Chrome's process tree used about 20% (JPEG) and 45-60% (PNG) of one core, including the canvas drawing itself. A normal page repaints rarely and costs near zero.
- A press+release of `Input.dispatchMouseEvent` over the pipe returns in about 0.15 ms (ack only; paint latency was not measured).

### What breaks or needs work, item by item

| Concern | Assessment |
|---|---|
| Extension popup / action UI | Separate targets, screencastable (spike). yaah must draw its own toolbar: list extensions, call `chrome.action.openPopup()` through each extension's service worker, then mirror that page target in a popover, send input to it, and close it on blur. Popup size and anchoring were not measured; headless has no native bubble to anchor. Extension pages that open tabs or windows need target tracking. |
| 1Password inline menu | In-page content script UI: captured (spike used a stand-in, not 1Password). Likely fine. The menu may render in a closed shadow root or iframe; both are still pixels. |
| 1Password desktop handshake | The desktop app verifies the browser by code signature/process, and the native-messaging host manifest must allow the extension id. Real Google Chrome is signed and recognised; a custom `--user-data-dir` should still talk to it, but that is **not tested**. Where the host manifest is read from for a non-default profile on macOS and Linux is the unknown to check. |
| Extension install | Chrome Web Store "Add to Chrome" needs a UI click and, in headless, is untested. Fallback: download the CRX by id, unzip and use `Extensions.loadUnpacked`. Loading unpacked changes update behaviour (no store auto-update) and may change how extensions identify themselves. Untested with 1Password. |
| Passkeys / WebAuthn | The platform authenticator (Touch ID) is a native sheet and will not appear in a screencast; headless has none. 1Password's passkeys work through the extension (content-script override), so they may work; hardware keys likely not. Mark as a limitation. |
| Native file pickers | `Page.setInterceptFileChooserDialog` then `Page.fileChooserOpened`: yaah opens its own native dialog and calls `DOM.setFileInputFiles`. Doable, not tried. |
| Permission bubbles | Chrome's bubble is native UI, absent from the screencast. Headless auto-denies. yaah has to decide per origin ahead of time (`Browser.setPermission`/`grantPermissions`) and show its own prompt; there is no obvious CDP event for "page asked". Unverified. |
| DevTools | Not shipped in the pane. Option: yaah offers "Open DevTools" that opens `http://127.0.0.1:<port>`-style frontend only if a port is enabled, which weakens the pipe-only stance. Prefer a console/network view fed by CDP events (vitro's journal is the model). |
| Video / audio | Video frames render and screencast; frame rate is capped by ack round trips and `everyNthFrame`. Audio plays from the Chrome process itself (vitro mutes it; yaah should not). DRM video needs Widevine, absent in Chromium-only builds. |
| HiDPI | vitro pins DPR 1, so text is soft on a Retina display. For a docked pane, set `Emulation.setDeviceMetricsOverride` to the pane size and the real device scale factor; frames then carry 4x the pixels at DPR 2. Budget bandwidth accordingly; this was not measured. |
| Frame rate and CPU | See spike: fine on average pages; worst case about a fifth to half of a core. Throttle to the pane's visibility; stop when the pane is hidden. |
| Input: mouse, scroll, keyboard | `Input.dispatchMouseEvent` (including `mouseWheel`) and `dispatchKeyEvent` are what vitro already uses for agents (`cdp.ex:1299-1340`, `:1385-1405`) and are trusted events. Map DOM `KeyboardEvent` to CDP `key`/`code`/`windowsVirtualKeyCode`/`modifiers`. Shortcut handling (copy, paste, select all) needs the `commands` field on key events. |
| IME / composition | `Input.imeSetComposition` and `Input.insertText` exist; mapping the webview's `compositionstart/update/end` is known work, no vitro precedent. The risk is candidate-window position. Test with Japanese and Chinese IMEs. |
| Clipboard | The page's clipboard is Chrome's own. Paste: read in yaah's webview on user gesture and `Input.insertText`/paste command; copy: read selection with `Runtime.evaluate` after the key. Not seamless. |
| Drag and drop | `Input.dispatchDragEvent` and `Input.setInterceptDrags`; dragging files from the OS into the pane needs yaah to translate Tauri's drop event. Rough. |
| Cursor shape | Not in the screencast. Cheap workaround: query `getComputedStyle(elementFromPoint).cursor` on pointer move (throttled). |
| Tabs and popups | Track `Target.targetCreated`/`attachedToTarget` with `setAutoAttach` and `windowOpen`; map each page target to a tab in yaah's tab strip. vitro has none of this. |
| Downloads | `Browser.setDownloadBehavior` with events; yaah chooses the folder (as browser-pane.md section 4). |
| Page focus and visibility | A headless page may not believe it is focused or visible. `Emulation.setFocusEmulationEnabled(true)` is needed so `:focus`, autofocus and extension focus logic behave. Untested. |
| Bot detection | Headless UA and automation signals trip some sites (the Cloudflare class). Override the UA and avoid `--enable-automation`. Untested. |
| Latency | Round trip is screencast encode + pipe + yaah backend + IPC to the webview + decode + paint. Expect tens of milliseconds, noticeable but usable for browsing and login; this is not a measured number. The spike harness can measure it end to end. |

Choice of renderer in yaah: do not copy vitro's blob-URL-per-frame. Use binary Tauri channel messages and `createImageBitmap` into a `<canvas>` (or WebCodecs `VideoDecoder` if later switching to H.264, which CDP screencast cannot produce).

### Headless or headed Chrome?

Use headless (`--headless=new`) so Chrome shows no window of its own and the pane is the only view. New headless runs extensions (spike). Headed Chrome off-screen is brittle on Linux/Wayland and flashes a Dock icon on macOS.

## 3. Reuse: embed, depend, or re-implement

**Facts.** Both projects are the user's; vitro is Apache-2.0 (`LICENSE`), so there is no licensing obstacle. vitro is Elixir (Francis + ex_tauri), not Rust, so there is no crate to link. Its desktop app is 20 MB (`/Applications/Vitro.app`). The CDP transport is small: framing of NUL-delimited JSON, id correlation, session ids (`connection.ex`). The valuable parts are knowledge, not code: actionability checks, snapshot uids tied to `loaderId`, ack-gated screencast, launch flags, reaper logic.

**Option A: yaah depends on a running vitro and the pane is a vitro session.** Rejected as the pane. Reasons:
1. The wall is view-only (section 1). Input forwarding would be new work in vitro's UI and a new control message in the websocket.
2. Sessions are BrowserContexts, which have no extensions (spike: content script absent in a created context). Fixing that needs a per-session Chrome with a real profile, which vitro's README says it removed on purpose ("One kind of session"; `slots.ex:14`: flags are per process, so extensions would be fleet-wide).
3. Profiles are temp dirs that stall and get rebuilt from cookie dumps, not a persistent user profile.
4. Coupling cost: two apps to install and keep in step (the README warns about stale daemons and version skew, and the vitro-desktop skill documents "which vitro is your vitro"). A yaah feature that needs vitro running is a support burden.

**Option B: yaah embeds the same design in Rust.** Chosen. A `browser` module with: Chrome discovery (add Brave/Edge to vitro's list; allow user path), pipe transport, a CDP session multiplexer, screencast with ack and demand control, an input mapper, and target tracking. A Rust CDP client crate may save the framing code, but any dependency should be checked on its own; a pipe transport is only a few hundred lines.

**Option C: optional vitro attach later.** Add an "attach to external Chrome" transport to vitro (it already has a second transport, vsock, `connection.ex:259-285`), so the same shared browser could also be driven by agents using vitro's tools and skills. This needs yaah to expose a token-guarded CDP endpoint, which reopens the port-hijack risk the pipe avoids. Keep it optional and off by default.

**The agent and the user sharing one browser** is the right product shape, and Option B delivers it: yaah owns the single CDP connection, multiplexes user input and agent `browser_*` calls onto it, and shows both in the pane. Mirror vitro's tool names and semantics (snapshot with uids that go stale on navigation, `click`/`fill` refusing obscured or disabled targets, `evaluate` gated) so agent habits and vitro's skill docs carry over. Agents that already use vitro MCP can keep doing so for their own isolated sessions; the yaah pane is a different thing (the user's logged-in browser) and should be a separate MCP server.

## 4. Security lessons from vitro and how the pane applies them

What vitro does:
- **Leases.** `create_session` returns a secret lease once; every scoped call needs it. This is explicitly not a defence against a hostile local process (127.0.0.1 plus a per-install bearer token is that); it stops twelve agents from "cleaning up" each other's sessions (README.md "Leases").
- **Isolation between agents.** One BrowserContext per session: separate cookies, storage, cache, permissions, in a shared browser process. Crash isolation is only OTP-level; a browser crash kills all sessions (README.md "Session model").
- **Journal.** Every tool call, with before/after frames, console, network, errors, is recorded off the MCP channel, so the human sees detail without spending agent context (`fleet/journal.ex`, `core.ex:~98-135`).
- **Refusals.** `file:`, `chrome:`, `view-source:`, `javascript:`, `devtools:` URLs are refused unless the owner enables `allow_file_urls`; `upload_file` can be confined with `upload_root` (`vitro-lib/lib/vitro/url_policy.ex:1-60`, `config.ex:~317`). Actuation refuses obscured, disabled and stale targets (README.md "Open risks").
- **The four dangerous tools:** `evaluate`, `get_storage_state`, `set_storage_state`, `upload_file` (vitro-tools skill, "Handle these four with care").
- **File and process hygiene.** Everything sensitive is 0700/0600 (`private.ex:1-30`); the browser environment is an allow-list (`chrome.ex:22-34`); the bearer token compares in constant time.

Be honest about what is not enforced: **vitro does not keep cookies away from agents in code.** `get_storage_state` returns cookies verbatim and `evaluate` can read anything the page can; the protection is skill text telling the agent not to leak, plus session isolation (agent A never sees B's cookies). Its own docs call `evaluate` plus `get_storage_state` the exfiltration pair. Frames of the page, including a filled login form, are retained on disk for the scrubber (`screencast.ex` history, `history.ex`). That was acceptable for throwaway test sessions. It is not acceptable for a profile that holds the user's real logins.

For yaah, where the agent drives a **logged-in, extension-equipped profile**, tighten this:
1. **No credential-reading tools.** Do not ship `get_storage_state`/`set_storage_state` equivalents. Do not expose `evaluate` in the default tool set, or expose it only behind a per-call approval (yaah already has a permission UI for agent actions).
2. **Agent control is an explicit toggle per pane**, off by default, visibly on (border plus status), with a stop button that revokes immediately. Use a lease-like token per ACP session so one agent cannot drive another's pane.
3. **Origin allow-list per pane for agents.** Even with the toggle on, the agent can act only on origins the user approved for that pane; navigation to others asks. Treat the page as untrusted input and say so in the tool descriptions.
4. **Redaction.** Do not return values of `type=password` fields, and do not return text typed by the password manager, in snapshots; do not log typed text in the journal (vitro's journal records tool, uid, ok, ms, not the text, `core.ex:~106-114`; keep that). Never send frames to the agent unless it asks for a screenshot, and let the user disable screenshots for a pane.
5. **Frames are not stored by default.** No scrubber history on the user's profile. If a replay feature is wanted, keep it in memory.
6. **Refuse the same URL schemes** as vitro, plus `chrome-extension://` for agent navigation (it must not open extension pages such as the password manager's vault view), and block agent access to `chrome://` settings and extension management.
7. **Extension pages and popups are never agent-reachable.** Agent tools list only the user-facing tabs. The agent cannot click inside a 1Password popup. It can type into a field and let the inline menu be used by the human, or ask the human.
8. **Pipe, not port**, and no `--remote-allow-origins`. The profile directory is 0700 under yaah's data dir; do not let `Mix`-like environments inherit secrets into Chrome (copy vitro's env allow-list). Do not use `--password-store=basic` or the mock keychain for the user's profile.
9. **Isolate from yaah's own origins** (as browser-pane.md section 4) and from other panes: one Chrome profile per project/pane group, with a private (incognito-like) pane option as a separate BrowserContext (which has no extensions by design).
10. **Uploads and downloads** go through yaah's dialogs; no agent `upload_file` in the MVP.

## 5. Recommendation

Revised plan:

**Architecture (macOS and Linux, same).** Rust `browser` module in `src-tauri`: finds Chrome, launches it with `--remote-debugging-pipe --user-data-dir=<yaah data>/browser/<profile> --headless=new --enable-unsafe-extension-debugging --no-first-run --no-default-browser-check`, multiplexes CDP sessions, tracks targets, and streams screencast frames to React over a Tauri channel. React draws the toolbar (address bar, tabs, extension buttons) and a `<canvas>` for frames, and sends pointer/key/IME/wheel events. Rust owns the profile and is the single CDP client, so user input and agent tools share one browser. If Chrome is missing, offer a download of Chrome for Testing (vitro already knows the JSON endpoint, `chrome.ex:10`) or the user's installed Chrome/Brave/Edge. A pane kind `{kind: "browser", url, profile, id}` like the terminal's.

**Phases.**
1. **Spike (3-5 days)**, below.
2. **MVP (3-4 weeks):** one tab, address bar, screencast with demand control, mouse/keyboard/wheel, DPR, resize, downloads, file chooser, popups as tabs, clean shutdown, profile per project, private pane. Safe defaults as in section 4. No agent. Work is mostly input mapping and target tracking.
3. **Extensions (2-3 weeks after MVP):** install by CRX id into the profile (loadUnpacked), extension list in the toolbar, popup mirror, options pages as tabs, 1Password handshake test, settings for "where to get extensions" and a trust warning. Gate on spike item 4.
4. **Shared agent driving (3-4 weeks):** `browser_*` MCP tools in Rust modelled on vitro's (snapshot via `Accessibility.getFullAXTree` with uids tied to `loaderId`, click/fill with actionability), the toggle, origin approvals and redaction of section 4. Optional vitro attach later.

Total roughly 8-11 weeks for the full path, against the 5-8 weeks plus Tauri 3 migration for CEF. The MVP carries the same pane-kind and layout work as the earlier plan but without the z-order and Linux placement risks.

**Risks.**
- 1Password may still refuse the setup or fail native messaging with a custom profile (high impact; the whole extension phase depends on it).
- Input fidelity (IME, clipboard, drag, cursor) will take iterations; users will notice small differences from a normal browser.
- Chrome must be present; headless-specific gaps (permission prompts, passkey sheets, bot detection, focus emulation).
- Screencast bandwidth at Retina scale; the default JPEG is lossy and PNG is expensive.
- Chrome 13x+ policy churn on extension loading (`Extensions.loadUnpacked` behind `--enable-unsafe-extension-debugging` is a debugging surface that Google could restrict).
- Security: an agent driving a real logged-in profile is a larger prize than any test session; section 4 must ship with the first agent feature, not after.

**What would change the recommendation:** if the spike shows 1Password cannot reach its desktop app under a yaah-launched Chrome, the extension phase falls back to "Open in my browser" (as in browser-pane.md) for the password manager only, and the pane remains valuable for browsing and agent driving. If input latency is poor (over about 80 ms visual), try a hybrid: native child webview on macOS for plain browsing, Chrome only for the extension/agent mode.

## What the spike measured

Files (outside both repos, not committed): `/private/tmp/claude-501/-Users-filipecabaco-Documents-workspace-yaah/db3a3876-6a4e-4137-ac8f-d6a19e7c13e4/scratchpad/spike/spike.exs` (Elixir script with no dependencies, using only `Port` and the built-in `JSON`), an MV3 test extension in `.../spike/ext/`, and `spike3.exs` (the BrowserContext check). Machine: macOS, Apple Chrome 157.0.8103.39, fresh temp profile in the spike directory. It does not touch vitro's running instance, port 1420/1421 or `pnpm tauri dev`. Chrome was stopped at the end; no stray process remained.

| Check | Result |
|---|---|
| `Extensions.loadUnpacked` with `--enable-unsafe-extension-debugging`, headless=new, pipe | Works; returned an id |
| Content-script overlay on `https://example.com` | Present in the page |
| Same extension, page in a `Target.createBrowserContext` context | **Not present** ("NO MENU") |
| Extension service worker target; `chrome.action.openPopup()` | Resolved; a popup `page` target appeared |
| Popup page screencast | A frame was received |
| Screencast, animated canvas worst case | JPEG q70: 59.8 fps, 1.6 MB/s, about 21% core; PNG: 60 fps, 3.5 MB/s, 45-60% core |
| CDP input ack over pipe | about 0.15 ms median (no paint) |

Not measured: real 1Password, desktop handshake, Web Store install, screen-to-glass latency, HiDPI, IME, popup sizing, idle CPU on a typical page, Linux.

## The de-risking spike to build next

Two to three days, in a scratch Tauri app outside the repo, macOS first and a Linux VM second.

1. **Pane loop.** A Rust command launches Chrome (flags above), a React canvas shows screencast frames over a Tauri channel, and mouse/wheel/key events go back. Measure **click-to-pixel latency** (timestamp in a test page that flips colour on mousedown, filmed or measured with a high-speed camera app, or compare `performance.now()` at event and at the next frame arrival) at 1x and 2x DPR; frames/s and bytes/s on three real pages (text article, a video, a web app); CPU of Chrome and of yaah's webview.
2. **Input fidelity checklist.** Typing with IME (Japanese), paste, copy, select-all, scroll with a trackpad, drag a link, right-click, text selection, a `<select>` dropdown (a native popup in Chrome; check it appears), `alert`/`confirm`, a file input, a download, `window.open`.
3. **Overlay test.** Put a yaah DOM dialog over the canvas: it should just work. Confirm the original z-order problem is gone.
4. **1Password test.** In that profile install 1Password from the Chrome Web Store (headed once with a normal window if needed to click "Add to Chrome", then reuse the profile headless), or unpack the CRX. Sign in through the desktop app, check: inline menu on a login form, popup via `chrome.action.openPopup()`, unlock via the desktop app, passkey creation. Record where Chrome looks for `NativeMessagingHosts` for a non-default `--user-data-dir` on both OSes and whether 1Password's host manifest is found. This is the single most important result.
5. **Linux.** Repeat 1 and 4 on x86_64 and arm64, Wayland and X11.

Pass: latency under about 80 ms at 1x, input checklist mostly green, 1Password autofill and unlock working. Fail on 4 means extensions fall back to the external-browser answer; fail on 1 means evaluate the hybrid.

A one-hour version using only vitro's existing pieces is not possible: its wall cannot send input and its sessions cannot hold extensions. The Elixir script above already is the cheapest chromium-side spike; extending it with a tiny Francis page (WebSocket frames in, mouse/key events out) is a day's work and would answer item 1 without Tauri.

## Sources

- vitro files cited above, under `/Users/filipecabaco/Documents/workspace/vitro` (`vitro-lib/lib/vitro/chrome.ex`, `cdp/connection.ex`, `screencast.ex`, `reaper.ex`, `private.ex`, `url_policy.ex`, `config.ex`, `core.ex`, `history.ex`, `browser/cdp.ex`, `vitro-desktop/lib/vitro/ui.ex`, `README.md`) and the skills in `~/.claude/skills/vitro*`. Line numbers marked with `~` are approximate.
- Spike results above are from my own run on 2026-11-04.
- Claims about branded Chrome dropping `--load-extension` (137), Chrome's `--remote-debugging-port` change (136), and the CDP methods named for file choosers, permissions, IME, drag and downloads come from prior knowledge and were not re-fetched; no web fetch tool was available in this session. Verify them in the spike.
