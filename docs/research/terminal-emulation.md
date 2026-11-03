# Terminal emulation for yaah

3 November 2026. Research with Sonnet; anything not checked against a primary source is marked UNVERIFIED.
**Decision (the user):** xterm.js 6 with the WebGL addon, behind a small `TerminalView` interface. libghostty is the
migration path.

## Options

| Option | State | Licence | Rendering | WebKit/Linux | Bundle | CSP | Notes |
|---|---|---|---|---|---|---|---|
| **xterm.js 6 + WebGL** | 21.3k stars, 6.0.0 (canvas renderer removed; OSC 52 and DEC 2026 synchronized output added); used by VS Code, Tabby, Hyper, JupyterLab, Wave | MIT | WebGL2, with DOM as the fallback | Works (WebGL2 in WKWebView and WebKitGTK) | ~489 KB plus addons | No change | Weak spots: heavy output (about 40% of the time goes to viewport and line caching), grapheme support still an experimental addon, a scroll-jump bug with DEC 2026, the Kitty keyboard protocol |
| **ghostty-web** (Coder) | ~3k stars, v0.4.0, xterm-compatible API | MIT | Canvas 2D over libghostty-vt WASM | WebKit not stated | ~400 KB WASM | `'wasm-unsafe-eval'` | A reported WASM memory-corruption bug with several instances (2code #145); CJK IME reported broken |
| **wterm** (Vercel Labs) | ~3.6k stars, experimental, no releases | Apache-2.0 | DOM, dirty rows, `WorkerCore`; optional Ghostty core | Safe (DOM) | 12 KB core, or ~400 KB with the Ghostty core | `'wasm-unsafe-eval'` | Native DOM selection and find |
| **restty** | 418 stars, early | MIT | WebGPU with a WebGL2 fallback; libghostty-vt | WebGPU needs macOS Tahoe; not on WebKitGTK | — | `'wasm-unsafe-eval'` | Early release |
| **libghostty-vt** (raw WASM, or Rust bindings) | Ghostty 63k stars; C API "effectively complete", signatures still in flux, no version tag | MIT | You write the renderer | — | ~876 KB full | `'wasm-unsafe-eval'` (WASM) | The best VT correctness |
| **alacritty_terminal / wezterm-term / vt100** (Rust state, custom web renderer) | Mature crates | Apache-2.0 / MIT | Yours | — | No JS | None | 2,000–4,000 lines of bridge code; full redraws over IPC are costly |
| **Native child view** | Tauri multiwebview behind the `unstable` feature, with many open issues | — | Native | Separate work per OS | — | — | Can't sit inside scrolling tool cards; z-order and shortcut bugs |

- **WebGPU:** Safari 26 ships it (macOS Tahoe or later); no confirmation for WebKitGTK; Tauri closed its WebGPU request.
  Target WebGL2 and DOM.

## How yaah uses it
- **The interface:** `TerminalView` with `write`, `resize`, `onData`, `onResize`, `focus`, `setTheme`, `search`,
  `serialize` and `dispose`, plus one engine module.
- **Interactive panes:** one xterm instance each (WebGL, falling back to DOM).
- **Tool-card terminals:** the DOM renderer, created lazily, with finished output replayed from stored bytes.
- **Rust:** `portable-pty`, sending binary bytes over a Tauri channel, with backpressure. Writes are batched per frame
  and scrollback is capped.
- **OSC 52** goes through the interface, with an opt-in prompt.
- **Revisit libghostty** when it's tagged, ghostty-web's multi-instance bug is confirmed fixed, or xterm.js adopts it
  (xterm.js#5686).

## Sources
- https://github.com/xtermjs/xterm.js · https://github.com/xtermjs/xterm.js/issues/5686
- https://github.com/coder/ghostty-web · https://github.com/vercel-labs/wterm · https://github.com/wiedymi/restty
- https://github.com/ghostty-org/ghostty · https://mitchellh.com/writing/libghostty-is-coming · https://github.com/Uzaaft/awesome-libghostty
- https://github.com/AkaraChen/2code/issues/145
- https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ · https://github.com/tauri-apps/tauri/issues/12846
- https://github.com/tauri-apps/tauri/issues/11376 · https://github.com/tauri-apps/tauri/issues/10420
