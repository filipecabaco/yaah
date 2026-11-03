# Installer and release pipeline, tested locally

Goal: install yaah with one command from GitHub releases, on macOS arm64, Linux x86_64 and Linux arm64, and a release
pipeline that produces those releases. The repository (`filipecabaco/yaah`) doesn't exist yet, so everything was tested
against a fake release folder served over local HTTP (`YAAH_RELEASE_BASE`).

What was built:

- `install.sh` (repository root): POSIX `sh` installer. Checked with `shellcheck -s sh` and run with dash, bash (macOS
  `/bin/sh`) and Debian's dash `/bin/sh`.
- `app/mise.toml` tasks: `release:build`, `release:checksums`, `release:linux:docker`.
- `ci/github-release.draft.yml`: the GitHub Actions version, not enabled (passes `actionlint`).
- `app/src-tauri/tauri.conf.json`: bundle targets `app`, `dmg`, `appimage`, `deb` (was `all`), ad-hoc macOS signing
  (`bundle.macOS.signingIdentity: "-"`), category and short description for the Linux packages.
- `app/src-tauri/src/main.rs`: `yaah --version` (and `-V`) prints `yaah 0.1.0` and returns before Tauri starts, so it
  works headless.
- `ci/Dockerfile`: the container's `rsync` skips `dist-release/`.

Machine: MacBook (Apple Silicon), OrbStack with 15 CPUs. Linux arm64 runs natively in the container; Linux x86_64
runs under OrbStack's Rosetta emulation.

## Assets

| asset                        |   size | from                                |
| ---------------------------- | -----: | ----------------------------------- |
| `yaah-macos-arm64.tar.gz`    | 5.5 MB | `yaah.app` (9.6 MiB), ad-hoc signed |
| `yaah-macos-arm64.dmg`       | 5.6 MB | `yaah_0.1.0_aarch64.dmg`            |
| `yaah-linux-arm64.AppImage`  |  83 MB | `yaah_0.1.0_aarch64.AppImage`       |
| `yaah-linux-arm64.deb`       | 6.3 MB | `yaah_0.1.0_arm64.deb`              |
| `yaah-linux-x86_64.AppImage` |  85 MB | `yaah_0.1.0_amd64.AppImage`         |
| `yaah-linux-x86_64.deb`      | 6.6 MB | `yaah_0.1.0_amd64.deb`              |
| `SHA256SUMS`                 |        | `sha256sum` format, the six above   |

No versioned copies: the tag is already in the URL (`releases/download/v0.1.0/yaah-…`), and `latest/download/` needs the
stable names.

## Build timings

| build                                                   | total | of which                                                                    |
| ------------------------------------------------------- | ----: | --------------------------------------------------------------------------- |
| macOS arm64, `mise run release:build`, on the Mac       | 170 s | Rust release build (LTO) 2 min 17 s                                         |
| Linux arm64, `release:linux:docker`, native             | 210 s | image cached from `yaah-ci`; Rust 2 min 17 s; fresh work volume             |
| Linux x86_64, `release:linux:docker`, Rosetta emulation | 604 s | image 3.5 min (`mise install` 69 s); `release:build` 378 s, Rust 4 min 43 s |

x86_64 under emulation works and is about 2× slower than native, so `release:linux:docker` builds both by default. In
CI it builds natively on `ubuntu-24.04`. Each arch has its own work volume (`yaah-release-work-<arch>`) so their
`target/` folders don't clobber each other; the Cargo registry and pnpm store volumes are shared with `ci:docker`.

## Install tests

The fake release was a folder with the six assets and `SHA256SUMS` from `mise run release:checksums`, served by a
20-line Bandit + Plug.Static script (`elixir serve.exs`); containers reached it at `host.docker.internal`. Install
times are the script's own run, assets served locally.

| #   | where                                                                               | what                                                                                       | result                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | macOS 26.7, `curl … \| sh`, `--prefix <temp>`                                       | install `yaah.app`                                                                         | pass, 0.88 s; `codesign -dv`: `Signature=adhoc`, flags `adhoc,runtime`, `Identifier=dev.yaah.app`; `codesign --verify --deep --strict` ok; no quarantine attribute; `yaah --version` 0.1.0 |
| 2   | macOS                                                                               | launch with `open -n --env HOME=<temp>`                                                    | pass: process up, a window titled "yaah", data written under the temp HOME                                                                                                                 |
| 3   | macOS, dash                                                                         | reinstall while the app runs                                                               | pass, 0.81 s: "yaah is running; asking it to quit", quit through Apple Events, replaced, no staging folder left                                                                            |
| 4   | macOS                                                                               | a release whose archive carries `com.apple.quarantine` (extracted app: `spctl` "rejected") | pass: installed with no quarantine left; opened through LaunchServices with no Gatekeeper prompt; `--uninstall` quit it and removed it                                                     |
| 5   | macOS                                                                               | `--uninstall --purge --dry-run`, then `--uninstall --purge` (temp HOME)                    | pass: dry run listed the app and `~/.yaah` and removed nothing; the real run removed both                                                                                                  |
| 6   | macOS                                                                               | `--dry-run` with an unreachable base URL                                                   | pass: plan printed, no network, nothing written (no temp folder either)                                                                                                                    |
| 7   | macOS                                                                               | asset changed by one byte; `SHA256SUMS` without its entry; a server answering 404          | pass: each aborts with a clear error, nothing installed                                                                                                                                    |
| 8   | macOS                                                                               | `--version 'v1;rm'`, `YAAH_REPO=x`, an unknown option, `--purge` alone                     | pass: each refused with a message, exit 1                                                                                                                                                  |
| 9   | Ubuntu 24.04 arm64, curl only, no FUSE, non-root                                    | AppImage                                                                                   | installs; FUSE hint; start check fails (`libfribidi.so.0` missing) and says why, see below                                                                                                 |
| 10  | Ubuntu 24.04 arm64, desktop libraries, `fuse3`, `/dev/fuse`, non-root, dash, piped  | AppImage, reinstall with `-q`, `--uninstall`                                               | pass, 0.44 s: `yaah 0.1.0` through FUSE; `desktop-file-validate` ok; icons 32, 128, 256@2; PATH warning; uninstall removed exactly those 5 files                                           |
| 11  | Debian 13 slim (`/bin/sh` is dash), wget only (no curl), desktop libraries, no FUSE | AppImage, piped to `sh`                                                                    | pass, 0.59 s: FUSE hint, `yaah 0.1.0` through `--appimage-extract-and-run`; entry valid; uninstall clean                                                                                   |
| 12  | Ubuntu 24.04 arm64, non-root with sudo, piped                                       | `--deb`, then `--uninstall` (no `--deb`), then `--uninstall --deb`                         | pass, 28 s (apt pulls WebKitGTK from the network): `/usr/bin/yaah --version` 0.1.0, entry valid, 3 icons; plain `--uninstall` pointed at `--deb`; the package was removed                  |
| 13  | Ubuntu 24.04 x86_64 (emulated), desktop libraries, FUSE, non-root                   | AppImage, reinstall, uninstall                                                             | pass, 0.92 s, same checks as 10                                                                                                                                                            |
| 14  | Ubuntu 24.04 x86_64 (emulated), root                                                | `--deb`, `--uninstall --deb`                                                               | pass, 53 s, same checks as 12                                                                                                                                                              |
| 15  | Debian 13 arm64                                                                     | wrong SHA-256 for the AppImage (non-root) and the .deb (root)                              | pass: both abort; nothing in `~`, package not installed, `/tmp` empty (trap cleaned up)                                                                                                    |
| 16  | Debian 13 arm64, non-root, no sudo                                                  | `--deb`                                                                                    | pass: "--deb needs root or sudo", before downloading                                                                                                                                       |
| 17  | Debian 13 arm64                                                                     | `--dry-run`, `--dry-run --deb`                                                             | pass: plans printed, `~` and `/tmp` untouched                                                                                                                                              |
| 18  | `linux/riscv64`, `linux/arm/v7`, `linux/s390x` (emulated)                           | install                                                                                    | pass: "yaah is built for Linux x86_64 and arm64 only; this machine is riscv64" (armv7l, s390x), exit 1                                                                                     |
| 19  | Debian 13                                                                           | the script cut at 4000 bytes, piped to `sh`                                                | pass: syntax error, nothing ran (all of it is in `main`, called on the last line)                                                                                                          |

The required checks stayed green after the change: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
`cargo test --lib --tests` (173 unit and the integration tests), `cargo deny check`, `pnpm check` (119 tests) and
`pnpm build`.

## Findings

- **The AppImage doesn't need libfuse2.** Tauri's bundler (tauri-cli 2.12.4) builds it with AppImage's static
  type2-runtime, which carries its own libfuse; it needs `/dev/fuse` and a `fusermount`/`fusermount3` binary (the
  `fuse3` package). `install.sh` checks for those and suggests `fuse3`; without them yaah still runs with
  `--appimage-extract-and-run`. `--appimage-extract` needs no FUSE, which is how the installer gets the icons out.
- **The AppImage expects a desktop's base libraries.** linuxdeploy leaves out the libraries on its excludelist, which
  every desktop has: on bare Ubuntu 24.04 that was libfribidi, fontconfig, freetype, harfbuzz, X11, xcb, Wayland
  client, gbm, drm, GL, EGL and expat; Debian 13 slim also lacked libgpg-error and libcom_err. The installer runs
  `yaah --version` once after installing and, if it fails, prints the loader error and suggests `--deb` (apt pulls in
  everything). On a desktop install nothing is missing.
- **curl downloads aren't quarantined**, so a `curl | sh` install wouldn't trigger Gatekeeper anyway; the installer
  still clears `com.apple.quarantine`, which matters when the archive or the script came through a browser. `spctl
--assess` rejects any ad-hoc-signed app; that only applies to quarantined ones.
- **`pnpm tauri build --ci`** skips the Finder window styling step of the DMG (it drives Finder with AppleScript), so
  the macOS build runs headless. `release:build` also sets `APPIMAGE_EXTRACT_AND_RUN=1` so linuxdeploy (an AppImage)
  runs where there's no FUSE, as in the container and on GitHub's runners.
- Tauri already ad-hoc signs with hardened runtime when `signingIdentity` is `"-"`, and reads `APPLE_SIGNING_IDENTITY`,
  `APPLE_CERTIFICATE`(`_PASSWORD`) and the notarisation variables from the environment; the workflow exports them only
  when the secrets are set, since an empty `APPLE_SIGNING_IDENTITY` would replace the ad-hoc identity.
- On macOS, `HOME=<temp>` doesn't move `~/Library`: WebKit created `~/Library/Caches/dev.yaah.app` and
  `~/Library/WebKit/dev.yaah.app` in the real home during the launch tests (removed afterwards). `--purge` deletes
  those folders.
- Another local server held `127.0.0.1:8766` while ours listened on `*:8766`, and requests went to the other one: the
  installer reported the 404 clearly. Test servers moved to unusual ports.

## Not done here

- No repository, tag or release exists yet; the workflow isn't enabled. Its five actions were checked to run on node24.
- The macOS x86_64 (Intel) build and Windows aren't produced, by decision.
- A GUI launch on Linux wasn't tried (headless containers); `yaah --version` loads the whole binary with its libraries.
