# Experiments

Screenshots and notes from experiments and visual checks, one folder per experiment (`YYYY-MM-DD-topic/`), each with a
README saying what was tried and what each image shows.

- [2026-11-03-split-panes](2026-11-03-split-panes/): Ghostty-style split panes (picker, focus, per-pane chats, dividers, saved layout) and the sidebar that resizes and hides to a title bar, in the browser mock at 1440 and 1920 and in the real macOS app with its traffic lights
- [2026-11-03-chat-layout](2026-11-03-chat-layout/): the chat using the window's width (before/after at 800–2560 px), tool cards named from their input, command output and diffs in tool cards, and switching a chat's agent
- [2026-11-03-installer](2026-11-03-installer/): `install.sh` and the release pipeline tested for real: macOS arm64 and Linux arm64/x86_64 bundles built locally (Linux in the CI container, x86_64 emulated), served as a fake release; installs, reinstalls, uninstalls, tampered checksums, unsupported CPUs, timings
- [2026-11-03-ci-docker](2026-11-03-ci-docker/): CI tuned locally in an Ubuntu 24.04 container (mise tasks, timings, cold and warm), and the first tier A adapter conformance run: every npm preset, pinned and latest, with npm audit
- [2026-11-03-agent-guide-live-test](2026-11-03-agent-guide-live-test/): the same prompts after teaching agents about yaah's UI. Sonnet used it in 5 of 6 (2 of 6 before), Codex in 3 of 3
- [2026-11-03-component-model-live-test](2026-11-03-component-model-live-test/): agent-built UI vs. Sonnet, before teaching agents about yaah
- [2026-11-03-projects-from-issues](2026-11-03-projects-from-issues/): starting a project from a GitHub, Linear or GitLab issue (picker, drafted prompt, linked item, GitLab settings)
- [2026-11-03-performance](2026-11-03-performance/): measured performance review, Rust side and interface (numbers, benchmark code, screenshots)
- [2026-11-03-website](2026-11-03-website/): screenshots of the app (browser mock, 2×, light and dark) used by the website in `site/`, and full-page checks of the site at 1440, 1024 and 375 px
- [earlier-ui-checks](earlier-ui-checks/): visual checks from earlier builds (command palette, diffs, quick chats, showcase)
