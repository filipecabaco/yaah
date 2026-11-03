# CI in Docker, and the first adapter conformance run

Goal: keep the ACP adapters current (they keep shipping CVE fixes) but run a new version only after a per-adapter suite
passes, and tune the CI flow locally in a container that emulates GitHub's `ubuntu-latest` before writing a workflow.

What was built:

- `app/src-tauri/src/agent_conformance.rs`: the suite. Tier A runs for real; tier B is prepared, not active.
- `app/src-tauri/examples/conformance.rs`: tier A headless, for every npm preset, pinned and latest.
- `app/mise.toml` tasks: `ci:rust`, `ci:web`, `ci:conformance`, `ci`, `ci:docker`.
- `ci/Dockerfile`: Ubuntu 24.04, Tauri's Linux dependencies, mise and the pinned toolchain.
- `ci/github-workflow.draft.yml`: the GitHub Actions version, not enabled.

Machine: MacBook (Apple Silicon, 18 cores), Docker 29.8.2 with 15 CPUs and 27 GiB for the VM. The container is
**linux/arm64** (native). GitHub's `ubuntu-latest` is x86_64; `docker build --platform linux/amd64` works under emulation
but is several times slower for the Rust build, and GitHub's `ubuntu-24.04-arm` runners match this container exactly.

## How the container runs

```sh
cd app
mise run ci:docker                   # build the image, run `mise run ci` in it
CI_TASK=ci:conformance mise run ci:docker
```

- The repository is mounted read-only at `/src` and `rsync`ed (without `.git`, `target`, `node_modules`, `dist`,
  `coverage`) into a volume, so the host's macOS `target/` and `node_modules/` are never touched or used.
- Volumes keep the Linux `target/` and `node_modules/` (`yaah-ci-work`), Cargo's registry (`yaah-ci-cargo`), the pnpm store
  (`yaah-ci-pnpm`) and the installed adapter versions (`yaah-ci-agents`).
- It runs as a non-root `runner` user, like GitHub's: some tests check file modes, which root ignores.
- Only the `[tools]` part of `mise.toml` goes into the image, from a small first stage, so editing a task rebuilds the
  image in about 2 s with the toolchain layer cached. Before that change, every task edit reinstalled the toolchain (36 s).
- No Docker-in-Docker: `tests/data_docker.rs` and `tests/data_postgres.rs` find no daemon or Postgres and skip (they
  print `skipped: …`, which libtest hides for passing tests). The GitHub runner has Docker, so `data_docker` runs there.

## Timings

| run                                                  | ci:rust | ci:web | ci:conformance | total             |
| ---------------------------------------------------- | ------: | -----: | -------------: | ----------------- |
| cold: volumes removed, image cached                  |       — |      — |              — | 168 s (`ci` 164 s) |
| cold: volumes removed, toolchain layer reinstalled   |    75 s |   25 s |           56 s | 226 s             |
| warm: nothing changed                                |     6 s |   22 s |           25 s | 59 s              |

- The first row predates per-task timings: nested `mise run` calls don't print their own, so `ci` now lists the tasks
  as task references (`run = [{ task = "ci:rust" }, …]`) and the image sets `MISE_TASK_TIMINGS=1`.
- Cold Rust: clippy's build 28 s, the test build 42 s, the tests themselves about 5 s.
- `ci:web` barely changes between cold and warm. pnpm's store makes the install quick; most of its time is `pnpm check`:
  tsc, ESLint, Prettier and Vitest (119 tests, about 4 s).
- `ci:conformance` cold: installing the 9 distinct versions (latest is the pin for 5 of the 7 presets) took 28 s in
  parallel, then 23 s of checks one at a time. Warm: the installs are reused and only the checks and audits run.
- The final run on the finished code, warm: `ci:rust` 7 s, `ci:web` 27 s, `ci:conformance` 28 s, 65 s in all, green.
- Image: 2 min 8 s from scratch, of which `mise install` was 38 s and exporting layers 34 s.

## Issues found, and what changed

- **codex-acp won't start when `CODEX_HOME` doesn't exist**: "CODEX_HOME points to …, but that path does not exist",
  exit 1. The first run failed codex's `initialize` for this. The sandbox now creates every config folder it points at.
- **claude-agent-acp's `claude` child outlives the adapter by 2 to 5 s.** The adapter exits as soon as its stdin
  closes, but the Claude Code process it started takes a few seconds to follow. With a 2 s grace the first run reported
  it as a leftover process. It does exit, so the grace is now 5 s, and a child still running after that is reported
  and killed. (`agents.rs` only kills the adapter on drop; this check is what would catch a real leak.)
- **No Linux-only bugs in yaah's code.** The Rust tests (173 unit, 16 ACP end-to-end, the data tests), clippy, cargo
  deny, the 119 frontend tests and the Vite build passed on Ubuntu 24.04 unchanged. The first container run stopped
  at `cargo fmt --check` on the new code, which was formatting, not Linux.
- Container details settled along the way: `MISE_TRUSTED_CONFIG_PATHS` so mise reads the copied `mise.toml` without a
  prompt; `--init` so the agents the suite starts are reaped; `procps` for process inspection.

## Isolation check

Tier A runs each adapter with `env_clear()` and a temp `HOME`, XDG folders, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
`TMPDIR`; only `PATH` is inherited. After the macOS runs, nothing under `~/.codex`, `~/.gemini` or `~/.copilot` was newer
than a marker file taken before them. `~/.claude*` changed only through the Claude Code sessions running at the time, and
no Claude config file mentions a sandbox path (Claude records every folder it runs in). On macOS the login keychain is
per user and can't be redirected. Tier A never prompts, but an adapter could read a token from it; none did: every
adapter that can tell asked for a login, and Claude's adapter accepts `session/new` without one by design. The Linux
container has no keychain.

## Tier A results

The same on macOS and in the container (Linux arm64), 2026-11-03. "blocked" means every check passed, but a high or
critical advisory would keep that version from being promoted. "checks" counts the generic checks plus the capabilities
yaah relies on for that preset (`EXPECTATIONS`).

| preset  | role   | version | result  | checks | advisories c/h/m/l |
| ------- | ------ | ------- | ------- | ------ | ------------------ |
| claude  | pinned | 0.99.1  | pass    | 12/12  | 0/0/0/0            |
| claude  | latest | 0.100.0 | pass    | 12/12  | 0/0/0/0            |
| gemini  | pinned | 0.66.0  | pass    | 9/9    | 0/0/0/0            |
| gemini  | latest | 0.66.0  | pass    | 9/9    | 0/0/0/0            |
| codex   | pinned | 2.5.0   | pass    | 11/11  | 0/0/0/0            |
| codex   | latest | 2.5.0   | pass    | 11/11  | 0/0/0/0            |
| copilot | pinned | 1.0.105 | pass    | 9/9    | 0/0/0/0            |
| copilot | latest | 1.0.105 | pass    | 9/9    | 0/0/0/0            |
| qwen    | pinned | 0.26.5  | blocked | 9/9    | 0/1/0/0            |
| qwen    | latest | 0.26.6  | blocked | 9/9    | 0/1/0/0            |
| auggie  | pinned | 0.36.0  | pass    | 7/7    | 0/0/0/0            |
| auggie  | latest | 0.36.0  | pass    | 7/7    | 0/0/0/0            |
| cline   | pinned | 3.0.74  | blocked | 7/7    | 2/9/10/4           |
| cline   | latest | 3.0.74  | blocked | 7/7    | 2/9/10/4           |

What each adapter advertised (pinned versions), which is what `EXPECTATIONS` now requires of newer ones:

| preset  | advertises                                                                               | signed-out `session/new`                    | login methods                                   |
| ------- | ---------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------- |
| claude  | loadSession, mcp.http, mcp.sse, systemPrompt, additionalDirectories, embeddedContext, image | works (session id)                          | claude-ai-login, console-login (terminal)       |
| codex   | loadSession, mcp.http, systemPrompt, additionalDirectories, embeddedContext, image       | auth required (-32000)                      | api-key, chat-gpt (agent)                       |
| gemini  | loadSession, mcp.http, mcp.sse, embeddedContext, image                                   | auth required: "Gemini API key is missing"  | oauth-personal, gemini-api-key, vertex-ai, gateway |
| copilot | loadSession, mcp.http, mcp.sse, embeddedContext, image                                   | auth required                               | copilot-login (agent)                           |
| qwen    | loadSession, mcp.http, mcp.sse, embeddedContext, image                                   | auth required                               | openai (agent)                                  |
| auggie  | loadSession, image                                                                       | auth required: "run `auggie login`"         | none                                            |
| cline   | loadSession, image                                                                       | auth required                               | cline, cline-pass, openai-codex (agent)         |

Every adapter answered `initialize` within 3 s (0.2 s for Claude's), answered the unknown method with -32601 and
stayed up, and exited once its stdin closed.

## Audit findings

- **qwen**: 0.26.5 (pinned) and 0.26.6 (latest) both pull `sharp` < 0.35.5: high, GHSA-wq5f-xc86-pv6w (librsvg,
  CVE-2026-96889). 0.26.6 would not be promoted, and the pin shows the advisory in Settings.
- **cline** 3.0.74 (pinned, and latest): 2 critical, 9 high, 10 moderate, 4 low.
  - Critical: GHSA-v5rq-49vh-5v5c (`@simple-git/argv-parser` < 2.0.1) and GHSA-x6jw-m9v5-85vh (`simple-git` 3.15 to 4.0.0).
  - High: `simple-git` ≤ 3.36.0 (GHSA-858h-whjf-mvg5, GHSA-g4wm-2vf7-vfgr), `undici` < 6.29.1 (five advisories),
    `zod` < 4.6.6 (GHSA-mrhx-c7xc-m3w5) and `@fastify/busboy` < 3.2.1 (GHSA-x8mw-p69m-v3mx).
  - There's no newer cline to move to. The advisories show in Settings once the daily audit has run.
- claude, codex, gemini, copilot and auggie: none.

The audit runs `npm audit --json --omit=dev` against the `package-lock.json` that `npm install --prefix` leaves in each
version's folder. It's tested against a stand-in registry (`audits_an_install_with_npm_itself`, real npm), and an
unreachable registry counts as "unavailable", not a failure.

## Not done here

- The workflow isn't enabled (`ci/github-workflow.draft.yml`). Its actions were checked to run on node24.
- Tier B (`agent_conformance::live`, `live_adapter_*` tests) wasn't run: it needs a signed-in account and spends prompts.
