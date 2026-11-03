# Agent starts: `npx -y` vs yaah's install (`node <bin>`)

Follow-up to item 8 of `docs/research/performance-review.md` ("Every agent start goes through `npx -y`").
yaah now installs each npm-based agent once into `~/.yaah/agents/<package>@<version>/` and starts its
program with `node` (`app/src-tauri/src/agent_install.rs`). This measures what that saves.

## How

- **Harness:** `agent_install::tests::measure_npx_vs_installed`, an `#[ignore]` test (it needs the network
  for the first install):

  ```sh
  cd app/src-tauri
  cargo test --release --lib measure_npx_vs_installed -- --ignored --nocapture
  ```

- **Agent:** the real `@agentclientprotocol/claude-agent-acp@0.99.1`, the Claude preset's pin.
- **What is timed:** from spawning the process to the answer to ACP `initialize`, through yaah's own
  `acp::Connection` and `agents::initialize`.
- **The two ways:**
  - `npx -y @agentclientprotocol/claude-agent-acp@0.99.1`, what yaah ran before;
  - the profile's own `process()`, which now resolves that same saved command to
    `node ~/.yaah/agents/@agentclientprotocol+claude-agent-acp@0.99.1/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`.
    The test asserts this.
- **Runs:** one warm-up of each (npx's cache and the file cache warm), then 7 runs of each, alternating.
- **Memory:** 1 s after `initialize`, the RSS of every descendant of the test process (`ps -A -o pid,ppid,rss`,
  `ps` itself excluded). After the connection is dropped (`kill_on_drop`), the descendants are counted again
  2 s later.
- **Config:** `CLAUDE_CONFIG_DIR` pointed at an empty temp folder, so nothing touched `~/.claude`.
- **Machine:** Apple M5 Pro, macOS 26.7.1, Node 26.11.1 and npm 11.20.0 (mise), rustc 1.99.1, release build.

## Results

| | `npx -y <pkg>@0.99.1` | `node <bin>` (yaah's install) | Difference |
|---|---|---|---|
| Spawn to `initialize` answer, median (min–max) | **808 ms** (794–872) | **129 ms** (127–140) | −679 ms, 6.3× faster |
| RSS of the agent's process tree, median | **313 MB** | **128 MB** | −185 MB per running agent |
| Processes per agent | 2 (npm's node + the adapter) | 1 (the adapter) | −1 |
| Processes left 2 s after the connection is dropped | 0 | 0 | |

Per run:

```
npx  init_ms=808 tree_rss_mb=314 procs=2   node init_ms=128 tree_rss_mb=128 procs=1
npx  init_ms=840 tree_rss_mb=312 procs=2   node init_ms=131 tree_rss_mb=129 procs=1
npx  init_ms=872 tree_rss_mb=322 procs=2   node init_ms=140 tree_rss_mb=129 procs=1
npx  init_ms=858 tree_rss_mb=315 procs=2   node init_ms=130 tree_rss_mb=128 procs=1
npx  init_ms=794 tree_rss_mb=313 procs=2   node init_ms=127 tree_rss_mb=128 procs=1
npx  init_ms=805 tree_rss_mb=312 procs=2   node init_ms=129 tree_rss_mb=128 procs=1
npx  init_ms=808 tree_rss_mb=313 procs=2   node init_ms=127 tree_rss_mb=129 procs=1
```

The one-time cost:

- **The install itself:** `npm install --prefix … --omit=dev` took 3.7 s here, with the package already in
  npm's cache from npx. It runs in the background on the first start, which still goes through npx, so no
  start waits for it.
- **Disk:** 341 MB for `claude-agent-acp@0.99.1` with its dependencies (it bundles the Claude Code CLI).
  Old version folders are removed at startup once nothing runs or waits on them.

## Notes

- **npx is slower here than in the review** (808 vs 405–431 ms). The review used an older npm and timed
  npx from its cache directly. This run goes through mise's `npx` with npm 11.20. The direct start is
  unchanged (129 vs 127–140 ms), so on this setup the saving is larger than the review's −280 ms estimate.
- **Memory:** npm's own node process accounts for the whole RSS difference (about 185 MB here, about
  115 MB in the review). With the direct start it isn't there at all.
- **An orphaned npx login on this machine:** a `claude-agent-acp --cli auth login` from npx's cache was
  still running with parent PID 1. A likely cause is that `kill_on_drop` (a cancelled login) killed npx,
  not the adapter under it. Now the adapter is the direct child, so dropping it kills the adapter itself.
  This wasn't reproduced on purpose.
