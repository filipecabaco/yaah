# Browser pane with extension support: research

Date: 2026-11-04. Research only; nothing in `app/` was changed and no spike was built.
Scope: a pane kind next to `terminal` that shows a real web browser, where 1Password and other extensions work. macOS (Apple silicon) and Linux (x86_64, arm64) only.

## Summary

- No single embedding gives "real extensions, 1Password included, one codebase, small bundle". The choice is a trade between bundle size and extension reach.
- **Chromium (CEF, Chrome runtime style) is the only option with evidence that 1Password runs inside an embedded view.** It costs about 170 MB, and Tauri's CEF runtime is a 3.0 alpha (Tauri 2 does not have it).
- **WKWebView (macOS) can host extensions through `WKWebExtensionController` (macOS 15.4+)**, but nobody has shown 1Password working there. Its Safari extension is tied to Safari and the 1Password app.
- **WebKitGTK (Linux) has no usable extension story yet.** Its "web process extensions" are unrelated. A real `WebExtension` API only began to appear in 2.52 and the manager API is still an unmerged PR.
- **Launching the user's own Chrome/Brave/Edge gives 1Password and all extensions for free**, at the cost of not being inside the pane at all.
- Recommendation: ship an **MVP with the system webview in a Tauri child webview (no extensions)**, plus an **"Open in my browser"** button that works today with the user's extensions. Run two spikes (below) before committing to the extension phase. If extensions in the pane are a hard requirement, the likely answer is CEF with Chrome runtime style on both platforms, accepting the size.

## Options table

| Option | macOS | Linux | Extensions | 1Password | Agent-drivable | Effort |
|---|---|---|---|---|---|---|
| Tauri 2 child webview (wry: WKWebView / WebKitGTK), no extensions | Works, rough edges | Layout bug on stock Tauri (child bounds ignored, fix unmerged) | None | No extension. `op` CLI or macOS AutoFill only | JS eval only, no CDP | M (2-3 weeks) |
| macOS WKWebView + `WKWebExtensionController` via objc2 | Yes, macOS 15.4+, needs own tab/window/permission plumbing | n/a | Unpacked MV2/MV3 folders and Safari app extensions that the app can reach | Unverified, probably not (see section 2) | JS eval and Web Inspector, no CDP | L (4-6 weeks) plus unknown |
| WebKitGTK + WebExtension API | n/a | API is new in 2.52, manager PR unmerged, distro versions lag | Not realistically yet | No | JS eval | Not viable now |
| CEF through `tauri-runtime-cef` (Tauri 3 alpha), Chrome runtime style | Yes, about 170 MB, 5 helper apps | Yes, large, sandbox caveats in AppImage | Chrome Web Store extensions install | Reported working (inline menu, standalone sign-in); desktop-app unlock unverified | Full CDP | L (5-8 weeks), plus Tauri 2 to 3 alpha migration risk |
| CEF with Alloy style / off-screen | Yes | Yes | None (removed in M128) | No | CDP | Not useful |
| Electron-style (separate Chromium app) | n/a | n/a | `electron-chrome-extensions`, partial; 1Password needed API shims | Partial, desktop-app verification fails | CDP | Rewrites the shell; rejected |
| External Chrome/Brave/Edge window with a yaah-owned profile | Yes | Yes | All, using the user's own profile | Works as normal (desktop integration needs the browser on 1Password's supported list) | CDP only with a non-default `--user-data-dir` | S (1 week), but not docked |
| Servo / Verso | Not mature | Not mature | None | No | Limited | Skip |

## 1. Embedding options

### Tauri 2 child webviews

yaah is on `tauri = "2"` with no features (`app/src-tauri/Cargo.toml`). A child webview needs the `unstable` feature and `Window::add_child(WebviewBuilder, position, size)`, then `set_bounds` to follow the pane's rect (measured in React with a `ResizeObserver`, sent to Rust, which owns the webview). The feature is still unstable: the Tauri issue tracker shows 23 open issues under the unstable scope, and since 2.12 the unstable crates are pinned to minor versions ([#15887](https://github.com/tauri-apps/tauri/issues/15887) as reported in search results).

Known problems that matter here:

- **Z-order.** A native child webview always draws above the main webview; there is no API to reorder ([#15682](https://github.com/tauri-apps/tauri/issues/15682), [#11124](https://github.com/tauri-apps/tauri/issues/11124)). yaah's menus, dialogs, toasts and the ⌘K palette are DOM in the main webview, so they would render behind the browser. Workarounds, all ugly: hide/shrink the child while any overlay is open (a snapshot image could stand in for it), or move overlays into their own child webview. A real-world write-up of a Tauri + CEF browser pane hit the same class of problem: AppKit routes clicks to the native view even under a React overlay, so they overrode `hitTest:` and added an overlay registry and a mouse-move monitor for partial overlaps ([atrium](https://getatrium.dev/blog/embedding-real-browser-tauri)). Expect that cost.
- **Linux layout.** Stock Tauri packs child webviews into a vertical `gtk::Box` and ignores their bounds ([#10420](https://github.com/tauri-apps/tauri/issues/10420), [#13071](https://github.com/tauri-apps/tauri/issues/13071)). The fix ([tauri#15463](https://github.com/tauri-apps/tauri/pull/15463), draft, blocked on a tao release; [wry#1745](https://github.com/tauri-apps/wry/pull/1745), open) is not released. We would need vendored patches or to wait.
- **Other reported bugs:** only the last child renders on some versions ([#11376](https://github.com/tauri-apps/tauri/issues/11376)), `add_child` regressions between patch releases ([#11452](https://github.com/tauri-apps/tauri/issues/11452)), and Cmd+A/C/V under the unstable flag ([#9257](https://github.com/tauri-apps/tauri/issues/9257)). Focus and keyboard shortcuts (yaah forwards ⌘K, ⌘D, ⌘W and so on from terminals) need explicit handling: key events in a child webview do not reach the main webview's JS.
- Reaching the native view: `Webview::with_webview` hands out `WKWebView` / `webkit2gtk::WebView` through objc2 types ([docs](https://docs.rs/tauri/latest/tauri/webview/struct.Webview.html)). That is the hook for configuring a data store, user agent or extension controller from Rust.

Verdict: workable for a plain browser on macOS; Linux is blocked on unreleased fixes; it gives no extensions by itself.

### macOS WKWebView and `WKWebExtension`

Apple added `WKWebExtension`, `WKWebExtensionContext` and `WKWebExtensionController` in macOS 15.4 / iOS 18.4 ([WKWebExtensionContext docs](https://developer.apple.com/documentation/webkit/wkwebextensioncontext), [Controller](https://developer.apple.com/documentation/webkit/wkwebextensioncontroller)). Any app can create a controller, load an extension from an unpacked folder (`WKWebExtension(resourceBaseURL:)`), wrap it in a context, call `controller.load(ctx)`, and set `config.webExtensionController` on the `WKWebViewConfiguration` before creating the web view. It runs Chrome-style manifests (MV2 and MV3 are both handled by WebKit, with Safari's API coverage).

What the embedder must provide, per a working example in another app ([easl PR #23](https://github.com/twaldin/easl/pull/23)): a tab and window model (`WKWebExtensionTab` / `Window` adapters), delegate methods for opening tabs/windows, options pages, action popups and permission prompts, and persistence of granted permissions (WebKit does not persist them). Extension pages need the context's own `webViewConfiguration`. `windows.create` was not implemented there, and passkeys need an Apple "managed browser" entitlement.

Rust access: the `objc2-web-kit` crate has generated bindings for `WKWebExtensionContext` and the controller delegate ([docs.rs](https://docs.rs/objc2-web-kit/latest/objc2_web_kit/struct.WKWebExtensionContext.html)), and wry already moved to objc2 so `with_webview().inner()` gives a typed `WKWebView`. The catch: the controller must be attached to the configuration **before** the web view is created, and wry builds the web view itself. You would need either a wry/tauri hook for the configuration or to build the child `WKWebView` yourself as a subview of the window (via `ns_window()`), bypassing Tauri's webview layer. I did not verify that wry exposes a configuration hook; treat it as a spike item. Implementing the delegate protocols in Rust means declaring Objective-C classes with `define_class!` in objc2: doable, not trivial.

**macOS floor.** 15.4 for extensions. yaah has no declared minimum in the files I checked; adopting this would raise the floor for the browser pane (feature-gate it, fall back to no extensions below 15.4).

**1Password on this path.** Its Safari extension is an app extension (`.appex`) inside 1Password.app, sandboxed and signed for Safari; its native-messaging peer is the desktop app. I found no 1Password documentation about third-party embedding, and the only third-party WKWebExtension integration I found explicitly did not test 1Password or Bitwarden ([easl PR #23](https://github.com/twaldin/easl/pull/23)). 1Password's own page on additional browsers covers only browsers that install the extension from the Chrome Web Store or Firefox site, and on Mac the browser must be in /Applications and Apple-code-signed ([1Password: additional browsers](https://support.1password.com/additional-browsers/)). So: the desktop-app handshake would likely be refused for yaah (not a recognised browser), and the Chrome-style extension would have to be loaded from an unpacked CRX, which Chrome Web Store terms and 1Password's update model do not support. The extension can fall back to working standalone with an account sign-in (one report says so for an Electron browser, [yarc PR #17](https://github.com/yenebeb/yarc/pull/17)), but that is still unverified under WebKit. **Plan for "probably no" and let the spike prove otherwise.**

### Linux WebKitGTK

Not the same thing as WebExtensions. WebKitGTK's long-standing "web (process) extensions" are C shared libraries loaded into the web process to touch the DOM and intercept requests; Epiphany uses them for form prefill and ad blocking, talking to the UI process over D-Bus ([Igalia](https://blogs.igalia.com/carlosgc/2013/09/10/webkit2gtk-web-process-extensions/), [WebKitGTK docs](https://webkitgtk.org/reference/webkit2gtk-web-extension/stable/index.html)). They have no `manifest.json`, no `chrome.*` API.

The browser-style WebExtensions API in WebKitGTK is new: 2.52.0 (March 2026) lists an "initial API for web extensions" ([release note](https://webkitgtk.org/2026/03/18/webkitgtk2.52.0-released.html)), and a PR to add `WebKitWebExtensionManager` (the GTK analogue of the controller) was still unreviewed in October 2026 ([WebKit#75929](https://github.com/WebKit/WebKit/pull/75929)). Even once it lands, distros ship old WebKitGTK; yaah's Linux users would be on whatever their distro has. And 1Password's Linux integration needs the browser listed in `/etc/1password/custom_allowed_browsers` (root edit) plus a native-messaging manifest the embedder would have to install. **No usable extension path on Linux with the system webview.**

### Chromium via CEF

- **Status.** Tauri has a CEF runtime in the 3.0 alpha line: `tauri-runtime-cef` 3.0.0-alpha.6 (14 Oct 2026, CEF 154.5) ([release](https://github.com/tauri-apps/tauri/releases/tag/tauri-runtime-cef-v3.0.0-alpha.6), [docs](https://v3.tauri.app/develop/cef/)). It is not in Tauri 2. Docs warn there is no API stability; it covers macOS, Linux and Windows. There are Linux issues open (for example no hardware WebGPU adapter, [#16203](https://github.com/tauri-apps/tauri/issues/16203)). Standalone ports built on published crates exist ([SpikeHD](https://github.com/SpikeHD/tauri-runtime-cef)) and say they retire when upstream ships.
- **Cost.** First build downloads about 1 GB of CEF; shipped bundles gain hundreds of MB (one app measured about 170 MB on macOS); the macOS bundle carries the CEF framework plus five helper apps; Linux AppImage may lose the process sandbox, deb/rpm keep it; extra memory at run time ([docs](https://v3.tauri.app/develop/cef/), [atrium](https://getatrium.dev/blog/embedding-real-browser-tauri)). Adopting it means moving yaah's whole shell to the CEF runtime, because the runtime is per-app, not per-pane. That also changes the main UI's engine (WKWebView/WebKitGTK today), so every layout, font and xterm WebGL behaviour needs re-testing, and yaah then owns Chromium security updates on a CEF release cadence.
- **Extensions.** Only **Chrome runtime style** supports them. The Alloy extension API was removed in M128, and Alloy and off-screen browsers do not support `chrome://extensions` ([CEF #3859](https://github.com/chromiumembedded/cef/issues/3859), [CefSharp discussion](https://github.com/cefsharp/CefSharp/discussions/4937)). Chrome style needs a windowed host. Tauri exposes the choice per window as `browser_runtime_style` ([docs](https://v3.tauri.app/develop/cef/)).
- **1Password.** One project reports switching its CEF browser panes from Alloy to Chrome style so that Chrome Web Store extensions install: 1Password installed from the Web Store and its inline menu attached to login fields in the panes and read the unlocked vault. Extension-opened tabs still popped out as standalone Chrome windows, and toolbar popup placement was unresolved ([herdr-app PR #1](https://github.com/Volpestyle/herdr-app/pull/1)). That is one project's pull request, not a vendor statement, and it does not say whether the desktop-app unlock worked. 1Password's desktop app verifies the calling browser by code signature and process tree, and rejects unknown ones ([yarc PR #17](https://github.com/yenebeb/yarc/pull/17), [textslashplain](https://textslashplain.com/2023/03/16/improving-native-message-host-reliability-on-windows/)); yaah's own signed binary would need to be added as a custom browser (Mac: must be Apple-signed, in /Applications; Linux: line in `/etc/1password/custom_allowed_browsers`). Also, native-messaging host manifests must be written into the CEF profile's `NativeMessagingHosts` location. Expect "extension works, signed in manually" as the floor and "unlock via desktop app" as the stretch.
- **Electron** is the same Chromium with a different shell; its extension support is partial (`electron-chrome-extensions` needed `browser.*` aliases for 1Password to work). Not worth switching frameworks.

### External browser window (Chrome / Chromium / Brave / Edge)

Spawn the user's browser, optionally in a yaah-owned profile (`--user-data-dir=~/.yaah/browser-profile`), optionally with `--remote-debugging-port` for CDP. Their extensions and 1Password work exactly as in daily use (Chrome, Brave, Edge, Firefox and Safari are 1Password's supported set; [1Password](https://support.1password.com/additional-browsers/)).

Honest UX: it is a separate window with its own Dock icon, tabs and chrome. A window cannot be docked inside another app's pane; the best yaah can do is place and size the window next to the yaah window using accessibility/AppleScript on macOS, which is brittle, and on Wayland impossible. It is a "browser companion", not a pane. Two constraints:

- Since Chrome 136, `--remote-debugging-port` is ignored for the default user-data directory, so CDP needs a separate profile, which has none of the user's extensions or logins until they install them there ([Chrome blog](https://developer.chrome.com/blog/remote-debugging-port), [issue](https://issues.chromium.org/issues/417456892)). Chrome 144 added an `autoConnect` path with a user-granted prompt for the real profile (search-result report; verify).
- Detecting installed browsers and their paths is Rust-owned and small.

### Other engines

Servo/Verso exist as experiments (Tauri's 2.0 roadmap mentioned Servo as a possible webview, [Tauri 2.0 post](https://v2.tauri.app/blog/tauri-20/)) but have no extension system and are not production-ready. Skip.

## 2. 1Password: what actually gives "fill my password in the pane"

| Mechanism | macOS | Linux | Notes |
|---|---|---|---|
| Browser extension + desktop app handshake (native messaging, browser signature check) | Only in a browser 1Password accepts; custom browsers must be Apple-signed in /Applications | Only for names in `/etc/1password/custom_allowed_browsers` | The best UX (biometric unlock). Requires a Chromium-class host with real extension support. |
| Extension signed in standalone (account password) | Possible where an extension host exists | Same | Works without the desktop handshake; less convenient. |
| macOS AutoFill credential provider | 1Password for Mac 8.12.32+ is a native provider for Safari and other apps ([release notes](https://releases.1password.com/mac/stable/)) | n/a | Does not cover arbitrary `WKWebView` content: a WKWebView has no browser credential plumbing; Keychain AutoFill is Safari-only; passkeys work only for the host app's associated domains ([portal#138](https://github.com/xiaoxinghu/portal/issues/138)). Passkeys in third-party browsers need Apple's managed-browser entitlement ([easl PR #23](https://github.com/twaldin/easl/pull/23)). Treat as unavailable. |
| `op` CLI | Yes | Yes | User enables "Integrate with 1Password CLI"; Touch ID prompts. yaah could add a "Fill from 1Password" button: Rust runs `op item get --fields` (argv, no shell), then injects with JS into the focused field. Works for any engine. It is a deliberate user action, not automatic fill, and secrets pass through yaah's process. |
| 1Password SDKs | Yes | Yes | Server/service-account oriented; the CLI route is the better fit for a desktop user's own vault. I found nothing in search that makes the SDK an autofill API. |

Practical conclusion: **automatic 1Password autofill in the pane means a Chromium host with Chrome-style extensions** (CEF) or the user's own browser. For a WebKit pane, the realistic offering is `op`-backed "fill this field" or "open in my browser".

## 3. Agent integration

- **Chromium (CEF or external browser):** the agent drives it through CDP. CEF can expose a remote-debugging port or use in-process DevTools methods; an external Chrome needs a non-default `--user-data-dir` (section 1). yaah would offer a tool through the existing per-chat MCP server (new `browser_*` tools next to `ui_*`), implemented in Rust, with a Rust-side CDP client. Snapshot (accessibility tree), click, type, navigate, screenshot, evaluate.
- **WebKit (wry):** no CDP. `WKWebView.evaluateJavaScript` and `WKUserScript` give DOM reads and clicks; `takeSnapshot` gives screenshots; Linux has `webkit_web_view_evaluate_javascript`. `safaridriver` drives Safari only, not embedded views. A WKWebView's Web Inspector protocol exists but is awkward ([atrium](https://getatrium.dev/blog/embedding-real-browser-tauri) found it harder for navigation, eval and snapshots). An agent layer on JS evaluation is feasible and small, but weaker (no network log, no trusted input events, shadow DOM and iframes need work).
- **Security model.** The pane holds the user's logged-in sessions; an agent that drives it can act as the user. Default rules:
  - A pane is **user-only by default**. Giving the agent control is a per-pane, per-chat toggle, off at start, visible in the pane's header ("Agent is controlling this pane" with a Stop button).
  - Every agent browser tool call goes through the same ACP permission flow as other tools; navigation to a new origin, form submits, and anything on a "sensitive" list (banking, password manager pages) ask first.
  - The agent never gets cookies, storage, or the 1Password vault; there is no `get_cookies` tool, and `evaluate` is not exposed in the MVP (only structured actions). Screenshots/DOM text are returned, and those can contain secrets: show what was sent in the tool card, and strip password field values and `type=password` content.
  - Prefer a **separate agent browsing profile** (empty, per project) over the user's logged-in profile. Offering "use my profile" is an explicit opt-in per project.
  - Page text is untrusted input to the model (prompt injection). Mark tool results as page content in the transcript.

## 4. Isolation and security

- **No IPC for browsed content.** In Tauri 2, capabilities attach to windows/webviews by label. A browser child webview gets **no capability file at all** and is created from a Rust-side `WebviewBuilder` with `.on_navigation` filtering, so it is not given `window.__TAURI__` IPC beyond what an empty capability allows. Verify in the spike that an unlisted webview cannot call any command (and that remote URLs are not covered by `remote.urls` entries). Keep `script-src 'self'` for the main webview; the child is a different webview and the CSP does not apply to it. Do not inject `initialization_script`s that expose yaah APIs.
- **Different origin from yaah.** Never load `tauri://` or yaah's local preview origins into the browser pane; the existing preview servers (`/preview/<id>/`, own port per chat) can be browsed because they are separate origins with their own CSP, but they stay unprivileged.
- **Data store.** WKWebView: `WKWebsiteDataStore(forIdentifier:)` (macOS 14+) gives a persistent named store per project or per pane; `nonPersistent()` for private mode. wry exposes a data directory on Linux/Windows and a data-store identifier on macOS (verify the exact wry option in the spike). CEF: one `CefRequestContext` / cache path per profile. Default proposal: one profile per project (so logins persist per project), plus an "incognito pane" option. Rust owns the profile path under `~/.yaah/browser/<profile>`; deleting a project deletes it.
- **Downloads.** Intercept in Rust (`WKDownloadDelegate`, WebKitGTK `download-started`, CEF download handler): save into a per-project downloads folder, show a notice with Reveal; never auto-open. Block downloads initiated by pages with no user gesture.
- **File pickers.** Allowed on user gesture, using the native panel; the agent cannot supply paths through the browser tools (no `upload_file` in the MVP).
- **Popups and `window.open`.** Route to Rust: same-origin or user-gesture popups become a new tab in the pane or a new pane; others are blocked with an inline notice. External protocols (`mailto:`, custom schemes) ask first. `file:` navigation is blocked.
- **Permissions (camera, mic, geolocation, notifications, clipboard read).** Deny by default; prompt per origin with a Rust-owned dialog, remembered per profile. On macOS the host app also needs the TCC usage strings and entitlements for camera/mic; add them only if the prompt is offered.
- **Navigation scope.** Allow `https:` and `http://localhost`; warn on `http:` elsewhere; show the real URL in the pane's address bar (Rust-provided), always visible, since an agent-driven pane can be a phishing surface.
- **TLS and certificate errors:** hard-fail, no click-through in the MVP.
- **Extensions add trust.** An extension sees every page in its profile. Ship none; the user installs their own, into a profile yaah controls, with a warning.

## 5. Recommendation

The main fact: extensions that work with 1Password need Chromium. The system webviews cannot deliver that on Linux at all and probably not for 1Password on macOS. So decide on how much "inside the pane" matters.

**Phase 0: two spikes (about 3-5 days).** See below.

**Phase 1: MVP browser pane (about 2-3 weeks), both platforms, system webview, no extensions.**
- Pane content `{ kind: "browser", url, profile, id }` saved with the layout like the terminal's.
- Rust owns the webview (child webview, bounds from the pane's rect, hide-on-overlay), address bar state, history, downloads, popups and permissions; React only draws the toolbar and reports the rect.
- Profile per project; private pane; the safe defaults of section 4.
- "Open in my browser" button (launches the user's default browser; opens with their extensions and 1Password) and an optional "Fill from 1Password" (`op`).
- On Linux this depends on the unreleased GTK positioning fix: vendor `[patch.crates-io]` for tauri-runtime-wry and wry, or ship macOS first.
- What we give up: extensions in-pane, autofill, passkeys.

**Phase 2: extensions (choose after the spikes).**
- **macOS 15.4+:** `WKWebExtensionController` with unpacked extension folders (4-6 weeks). Only worth it if the spike shows 1Password (or at least Bitwarden-like managers) works; if not, skip.
- **CEF with Chrome runtime style:** the path to 1Password in a pane on macOS and Linux (5-8 weeks plus the Tauri 3 alpha migration). Consider it only if users really insist; it makes yaah a 200+ MB app on a runtime with no stability promises, and moves the main UI onto Chromium. A less invasive variant if Tauri allows it: not possible, as the runtime is per app.
- **Cheaper alternative for the same goal:** a managed external browser (Phase 2b, about 1 week): launch Chrome/Brave with a yaah profile, track the window, and use CDP for the agent. Extensions and 1Password work as normal. The cost is that it is not a pane.

**Phase 3: agent driving (3-4 weeks).** `browser_*` MCP tools implemented in Rust: on WebKit through JS evaluation and snapshots, on Chromium through CDP. Toggle, prompts and redaction as in section 3.

**Risks.** Z-order and focus bugs in child webviews (high, visible); Tauri's unstable flag and CEF alpha churn; the 1Password handshake rejecting yaah (high on every path except the user's own browser); the macOS 15.4 floor; Linux distros' WebKitGTK versions.

**What we would give up** by choosing CEF: bundle size, one engine for the UI, a Chromium update treadmill, and the "stay close to stock, small" posture. By choosing WebKit only: automatic password-manager autofill.

**Suggested default:** Phase 1 now on both platforms, "Open in my browser" for the 1Password need, then decide Phase 2 from spike results. If the user needs 1Password autofill in the pane, plan on CEF and treat it as its own project.

## Spikes

1. **Child webview in a pane rect** (outside the repo, a fresh Tauri 2 app with `tauri = { features = ["unstable"] }`). React page with a `div` placed like a pane; a `ResizeObserver` sends `getBoundingClientRect` to a Rust command that calls `window.add_child(WebviewBuilder::new("browser", WebviewUrl::External(...)), pos, size)` then `set_bounds` on resize and on window move. Test on macOS and a Linux VM (x86_64 and arm64): bounds follow resizes; focus and ⌘ shortcuts; opening a React dialog over it (confirm it is covered; try hide-on-overlay); whether a child with no capability can call any `invoke`; `window.open` and download handlers via `on_new_window` / `on_download`. Success is a pass/fail table for each platform.
2. **`WKWebExtension` loading real extensions** (a throwaway Swift app is faster than Rust for this; port to objc2 only if it passes). Create a controller, load an unpacked Bitwarden or uBlock build and the Chrome 1Password CRX unpacked, attach to a `WKWebView`, implement minimal delegate (tabs/windows/action popup/permissions). Question to answer: does 1Password's popup open, does the inline menu attach, and does it reach the desktop app (native messaging via the delegate's connect method)? Also try loading 1Password's Safari `.appex` from /Applications/1Password.app. Record the macOS version tested (15.4+). A pass means Phase 2 macOS is viable; a fail makes CEF or external browser the only 1Password routes.

Optional third: build tauri-runtime-cef alpha in a scratch app with Chrome runtime style, install 1Password from the Web Store, and check the desktop-app unlock after adding the binary to 1Password's custom browser list. This answers the 1Password handshake question for Chromium.

## Biggest unknowns

1. Whether 1Password (Safari extension or Chrome extension) functions under `WKWebExtensionController` at all, including the desktop handshake. No source found either way.
2. Whether 1Password's desktop app will accept yaah (or a CEF-based yaah) as a custom browser, and whether that works for a non-standard-named, Apple-signed app on macOS and on Linux with the `custom_allowed_browsers` file.
3. Whether wry lets an embedder attach a `WKWebExtensionController` to the child webview's configuration, or whether we must create the `WKWebView` ourselves.
4. Real state of the Linux child-webview fix (tauri#15463 draft, wry#1745) and release timing.
5. Tauri 3 / CEF release date and API stability; whether Tauri 3's non-CEF runtime changes `add_child`.
6. Overlay z-order: how much native-view hit-testing work the DOM overlays need on each platform.
7. Some facts above come from search summaries of third-party PRs (herdr-app, easl, yarc) and not from vendor statements; re-verify them in the spikes.

## Sources

- Apple: [WKWebExtensionContext](https://developer.apple.com/documentation/webkit/wkwebextensioncontext), [WKWebExtensionController](https://developer.apple.com/documentation/webkit/wkwebextensioncontroller); [objc2-web-kit bindings](https://docs.rs/objc2-web-kit/latest/objc2_web_kit/struct.WKWebExtensionContext.html)
- Tauri: [Webview::with_webview](https://docs.rs/tauri/latest/tauri/webview/struct.Webview.html), [#15682](https://github.com/tauri-apps/tauri/issues/15682), [#10420 fix PR #15463](https://github.com/tauri-apps/tauri/pull/15463), [wry#1745](https://github.com/tauri-apps/wry/pull/1745), [#11376](https://github.com/tauri-apps/tauri/issues/11376), [#11452](https://github.com/tauri-apps/tauri/issues/11452)
- CEF in Tauri: [docs](https://v3.tauri.app/develop/cef/), [alpha.6 release](https://github.com/tauri-apps/tauri/releases/tag/tauri-runtime-cef-v3.0.0-alpha.6), [Linux WebGPU issue](https://github.com/tauri-apps/tauri/issues/16203), [SpikeHD port](https://github.com/SpikeHD/tauri-runtime-cef), [CEF #3859](https://github.com/chromiumembedded/cef/issues/3859), [CefSharp extensions discussion](https://github.com/cefsharp/CefSharp/discussions/4937), [herdr-app PR #1](https://github.com/Volpestyle/herdr-app/pull/1), [atrium write-up](https://getatrium.dev/blog/embedding-real-browser-tauri)
- WebKitGTK: [web process extensions](https://blogs.igalia.com/carlosgc/2013/09/10/webkit2gtk-web-process-extensions/), [2.52.0 release](https://webkitgtk.org/2026/03/18/webkitgtk2.52.0-released.html), [WebKitWebExtensionManager PR](https://github.com/WebKit/WebKit/pull/75929)
- 1Password: [additional browsers](https://support.1password.com/additional-browsers/), [Mac release notes (AutoFill provider)](https://releases.1password.com/mac/stable/), [easl PR #23](https://github.com/twaldin/easl/pull/23), [yarc PR #17](https://github.com/yenebeb/yarc/pull/17), [portal#138](https://github.com/xiaoxinghu/portal/issues/138)
- Chrome CDP: [remote-debugging-port change](https://developer.chrome.com/blog/remote-debugging-port), [Chromium issue 417456892](https://issues.chromium.org/issues/417456892)

See also: [browser-pane-vitro.md](browser-pane-vitro.md) for a revised recommendation (real Chrome over CDP screencast, docked in the pane) based on the vitro project and a small Chrome spike.
