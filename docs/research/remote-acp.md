# Remote ACP: can yaah talk to hosted agents?

4 November 2026. Research only. Sources: yaah's `acp.rs`, `agents.rs`, `session.rs`, `ui_mcp.rs`, `acp_terminals.rs`; the
installed adapters in `~/.yaah/agents/` (read-only); the ACP transport page and RFDs; issue trackers and docs of Zed,
goose, OpenCode and others. No remote agent was run. Items marked UNVERIFIED come from search summaries, issues or
inference, not from reading the primary source.

## Direct answer

Yes, it can be hosted. ACP is not tied to local data, but today's **stable transport is stdio only**, so "remote" means
one of two things:

1. **Carry the stdio stream somewhere else.** `ssh host <adapter>` works with no protocol change. The ACP spec explicitly
   allows custom transports.
2. **Use the new Streamable HTTP / WebSocket transport.** Its RFD is **Active** (since 2 July 2026) and goose ships it
   (`goose serve`). The other agents we run (Claude, Codex) don't yet.

Where the data lives is a separate question. By default the agent reads, writes and runs commands on **its own machine**.
It only touches the user's machine if the client advertises `fs` and `terminal` capabilities and the agent chooses to use
them. The common, working shape is **(a): remote agent, remote data** (a dev box with the repo cloned). Shape **(b): remote
model, local data** exists in the protocol but is weak in practice (see below).

**Recommendation:** first step is SSH stdio, scoped to "agent and repo both on the remote host". It is the smallest
change and works with every agent. Do the WebSocket transport second, behind the same `Transport` abstraction.

## How yaah is coupled to local today

- **Spawn and transport.** `acp.rs` `Connection::spawn(Command, ...)` takes a `tokio::process::Command`, pipes stdin,
  stdout and stderr, writes one JSON message per line and reads lines from stdout (`MAX_MESSAGE` cap). Shutdown closes
  stdin, waits, then kills. The transport is welded to a child process, but the surface is small: write line, read line,
  stderr tail, close, kill.
- **Agent profiles.** `agents.rs` builds a `Command` from `command_line` (`split_args`) plus env. There is no "where it
  runs" field.
- **Client methods.** `session.rs` (~line 2135) says `fs/*` is **not advertised**; unknown requests get
  `method_not_found`. Terminals are advertised (`clientCapabilities.terminal`) and served in yaah's own PTYs by
  `acp_terminals.rs`. `session/request_permission` goes to the UI.
- **Working folder.** `session/new` and `session/load` send `cwd` as a path on yaah's machine.
- **UI MCP.** `ui_mcp.rs` listens on `127.0.0.1` with a random port and a per-chat `/mcp/<token>` URL, passed to the agent
  in `session/new` (`mcpServers`). Also a per-chat preview origin on its own loopback port.
- **Local state.** Transcripts in `~/.yaah/sessions`, projects in `~/.yaah/projects`, adapters installed under
  `~/.yaah/agents`, resume and version checks read local stores and `.claude.json`.

So the protocol layer is already clean. The coupling is in **paths, installs, MCP and everything that reads the disk**.

## Transport status

### Spec
- The transports page defines **stdio only**. Remote transport is "being specified in the transport RFD". Custom
  transports are allowed if they keep the JSON-RPC format and lifecycle.
- **Streamable HTTP & WebSocket RFD** (status Active since 2026-07-02, aimed at v1 as additive):
  - One `/acp` endpoint, two profiles. WebSocket: GET with Upgrade, one JSON-RPC message per text frame. Streamable HTTP:
    HTTP/2, POST for client-to-server (202, answer arrives on the stream), long-lived GET SSE streams for server-to-client,
    DELETE to end.
  - Headers `Acp-Connection-Id` (from `initialize`) and `Acp-Session-Id` (from `session/new`). One connection can host
    several sessions. JSON-RPC batches rejected.
  - **Sessions outlive connections**; a client reconnects and calls `session/load`. v1 does **not** replay messages sent
    during a disconnect. Resumption (`Last-Event-ID` style), keepalive and reconnect semantics are v2.
  - Auth is left to the layer above: headers, query parameters or WebSocket subprotocols. IDs are not credentials.
  - Phase 4 still to do: `Acp-Protocol-Version` header, origin validation, SSE resumability, security audit.
- **MCP-over-ACP RFD** (draft, nikomatsakis): the client lists `{"type": "acp", serverId}` in `mcpServers`; the agent sends
  `mcp/message` over the ACP connection and the client runs the tool. No second network endpoint. Advertised by the agent
  under `mcpCapabilities.acp`. This is the clean answer to the localhost MCP problem once agents implement it.
  UNVERIFIED which agents (if any) implement it.

### Agents
| Agent | Remote today |
|---|---|
| goose | `goose serve`: ACP over HTTP and WebSocket at `/acp`, default `127.0.0.1:3284`, secret via `X-Secret-Key` (or `?token=` for browsers). Goose Desktop itself is a WebSocket client. Reference implementation of the RFD. Custom `_goose/*` methods change between releases. |
| OpenCode | `opencode serve` is a headless server (OpenAPI, optional basic auth) with `opencode attach`, but that is its own API, not ACP. An ACP-over-WebSocket request and PR exist (issue 13388). UNVERIFIED whether merged. |
| claude-agent-acp 0.100.0 (installed) | stdio only. No WebSocket or listener code found in the bundle. |
| codex-acp 2.5.0 (installed) | stdio only. No WebSocket code found. Codex has no serve/attach equivalent; cloud tasks (`codex cloud exec`) are a separate product, not ACP. |
| Zed | Runs ACP agents **on the remote host** for SSH projects. Support is recent and buggy (issues 47910, 47362, 52254). UNVERIFIED which release ships it. |
| Third-party bridges | `acpremote` (stdio agent to WebSocket and back), `agent-client-protocol-http` Rust crate (HTTP+SSE, WebSocket upgrade, server and client), `@rebornix/stdio-to-ws` used by acp-ui. |

Takeaway: for the agents users actually run, only the **stdio-over-SSH** path works, or a bridge process such as
`acpremote expose` on the remote.

## Where the data lives

ACP says the client may offer `fs/read_text_file`, `fs/write_text_file` and `terminal/*`. If it doesn't, or the agent
doesn't use them, the agent uses its own tools on its own machine.

**(a) Remote agent, remote data.** The repo is cloned on the host (dev box, container, cloud sandbox). The agent's file
tools and shell run there. The adapter, the CLI it wraps, and credentials live there. Works with every agent. Latency is
only between the UI and the host. `cwd` is a remote path.

**(b) Remote agent, local data.** The agent runs remotely and delegates through client `fs` and `terminal`. Every read,
write and command is a round trip to yaah. Feasibility depends on the agent actually delegating:
- **claude-agent-acp 0.100.0:** the adapter has `readTextFile`/`writeTextFile` wrapper methods and reads client
  capabilities, but the Claude Code CLI it wraps does its own Read/Edit/Bash. I found no call site that routes those tools
  through the client. Treat as **not delegating**. (Grep only, not exercised: UNVERIFIED.)
- **codex-acp 2.5.0:** reads `capabilities.terminal` and has terminal-output handling, which suggests terminal delegation;
  Codex's own sandbox does the file work. Whether commands run through `terminal/create` is UNVERIFIED.
- Others: not checked.

So (b) is not something to build on today. yaah already serves `terminal/*` locally, which is the half that is more likely
to be used, but it would need `fs/*` as well, with path checks, and a bandwidth and latency budget for large trees.
Also the model then sees local code, so "data stays local" only holds for disk, not for content sent to the model.

**MCP for a remote agent.** `ui_mcp.rs` is loopback-only, so a remote agent can't reach it. Options:
1. **SSH reverse forward** (`ssh -R`) of the MCP port: easy with the SSH option, token in the URL stays valid. Remote host
   users could also reach it, so the unguessable token matters.
2. **Tunnel/relay** (Cloudflare, Tailscale): works for the WebSocket option, adds an exposed endpoint.
3. **MCP-over-ACP** (draft): no network path, but needs agent support.
4. Run a UI MCP server **on the remote** and have yaah attach to its output. More work, but offline-safe.

Zed's experience (issue 52254): wrapping MCP servers for remote broke the agent's tool discovery, so pass the raw
configuration through and let the agent launch what it needs.

## Options

| Option | How | Pros | Cons | Effort |
|---|---|---|---|---|
| **SSH stdio** | `ssh host adapter`, same JSON lines | No protocol change; works with every agent; data and keys stay on the host; reuse of the user's SSH config, keys, agents | Needs the adapter installed on the host; reconnect means a new process; MCP needs `-R`; local-path features break | **S-M** |
| **HTTP/WebSocket ACP** | Connect to `goose serve` etc. | Standard, multi-session, sessions outlive the connection; no SSH | Only goose today; auth/TLS is ours; v1 has no replay; spec still moving | **M** |
| **Containers / sandboxes** | Docker, devcontainers, Codespaces, Coder, e2b, Daytona, Modal: run adapter inside via exec/SSH | Isolation; reproducible; fits shape (a) | Provisioning, image, repo clone, credentials injection; each provider has its own API | **M-L** (Docker exec is S, via the SSH-style stdio path) |
| **Relay / hosted yaah** | Browser UI to a server that runs agents | Zero install, shareable, mobile | yaah is a Tauri desktop app; the UI calls Tauri commands directly. Needs an HTTP/WS API, accounts, multi-tenant isolation, secrets handling | **L** |
| **(b) Local data** | Remote model, client `fs`/`terminal` | Data on the laptop | Agents mostly don't delegate; round trips; large trees slow | **L**, low value |

## Prior art
- **Zed**: external agents run on the SSH host; docs say credentials may be local, remote or via the agent's own sign-in.
  A discussion asks for a "run the agent locally, proxy tools to the remote" mode, which is shape (b).
- **goose**: `goose serve` and a WebSocket-client desktop. The closest to a hosted-ACP product.
- **OpenCode**: server and attach model with its own API; ACP WebSocket requested.
- **Claude Code**: Remote Control bridges a session running on a VM to the Claude app. Not ACP.
- **Codex cloud / Cursor background agents / GitHub Copilot coding agent**: managed cloud VMs that work on a repo clone
  and return a PR. They are shape (a) as a product, with their own APIs. UNVERIFIED details; not ACP.
- **Bridges**: `acpremote`, `agent-client-protocol-http`, `stdio-to-ws`, AionUi's open request for an SSH transport
  (issue 2721, which also concludes SSH is enough).
- **OpenHands, Amp, Warp**: not researched. UNVERIFIED.

## Security
- **Auth to the remote.** SSH: keys via the user's ssh-agent and `known_hosts`, never store passwords; use
  `BatchMode=yes` plus a visible prompt for host-key confirmation. WebSocket: wss only, bearer/secret header (goose uses a
  shared `X-Secret-Key`), store it in the keychain, mTLS if behind our own gateway. Never `--dangerously-unauthenticated`
  on a reachable interface.
- **Credential placement.** Provider keys and CLI logins stay on the remote host; yaah must not push keychain secrets
  there unless the user asks. yaah's current profile env (Bedrock/OpenRouter keys from the model-providers note) is local;
  for remote profiles the env belongs to the remote, with an explicit "send this variable" choice.
- **Permission prompts.** `session/request_permission` flows over the same channel, so prompts still reach the user. The
  risk is the remote agent running commands with no local sandbox: the remote host is the trust boundary.
- **Exposing yaah's MCP.** A reverse tunnel or public relay exposes UI tool calls; keep the random token, bind to
  loopback on the remote side, and drop the tunnel with the session.
- **Latency and offline.** Stdio over SSH dies with the connection and the agent process with it (unless run under
  `tmux`/`systemd`, which loses the pipe). Use `ServerAliveInterval`, and on drop, relaunch and `session/load` (yaah
  already supports it) provided the agent persists sessions on the host. The WebSocket transport keeps sessions alive across
  connections, but v1 drops in-flight messages. Show "disconnected" state and queue nothing silently.

## Recommended first step: SSH stdio

Justified: it is the only option that works today with Claude, Codex, goose and others without waiting on transports or
agents; it keeps data and credentials on the host; the code seam is small (`Command` becomes `ssh ... adapter`).
Refutation check: it does *not* solve hosted UI, shape (b) or multi-user. It also needs the adapter installed on the
host, which yaah's install flow can't do yet. If the goal is "a web UI for teammates", this is the wrong first step and
the relay is the only path. For "run on my dev box or container", it is right.

Suggested scope: a profile field `runs_on: local | ssh{host,user,port} | exec{docker,...}`; remote folder entered as text
(no picker); `-R` forward for the UI MCP; remote adapter assumed pre-installed; reconnect = relaunch + `session/load`.

## What would change in yaah

**Architecture**
- A `Transport` trait behind `acp.rs` (`send_line`, `recv_line`, `stderr_tail`, `close`, `kill`, `alive`). Implementations:
  child process (today), SSH child process (same code with a different `Command`), WebSocket (later, framing per text frame
  instead of per line).
- Agent profile gains a "where it runs" field and, for remote, host, user, port, and a remote working root.
- A remote path type distinct from local `PathBuf`; folder pickers become a text field, then a remote listing over SSH.
- Tunnel manager for the UI MCP (and preview origin) for SSH profiles.

**What breaks or needs a remote variant**
- **Local folder checks and project folders** (`~/.yaah/projects`, `cwd` validation).
- **Git sources** reading local repos (`git` calls would need to run over SSH or be disabled for remote).
- **Terminals**: yaah's own PTYs run locally; for remote runs, agent commands should execute on the host. Do not advertise
  `terminal` for remote profiles unless the agent runs there (it already does, so it would not use the client terminal).
- **"Open in terminal"** app and any file reveal/open: local only.
- **Resume**: reads local session stores and `.claude.json`; remote sessions live on the host, so rely on `session/load`
  and yaah's own transcripts.
- **Installs** into `~/.yaah/agents` and **version checks**/conformance: need a remote install and probe step, or a
  "remote, managed by you" flag.
- **Login detection** (`logged_in` from `.claude.json`) is local; remote profiles need the ACP auth flow or a manual flag.
- **Skills and context files** yaah writes for the agent (UI skills) live locally; they must be placed on the host.

## Sources
- ACP transports: https://agentclientprotocol.com/protocol/transports
- Streamable HTTP and WebSocket RFD: https://agentclientprotocol.com/rfds/streamable-http-websocket-transport
- MCP-over-ACP RFD: https://agentclientprotocol.com/rfds/mcp-over-acp
- RFD process: https://agentclientprotocol.com/rfds/about
- goose ACP docs: https://github.com/block/goose/blob/main/documentation/docs/gdk/acp/index.md
- goose discussion: https://github.com/aaif-goose/goose/discussions/7309
- Rust HTTP crate: https://docs.rs/crate/agent-client-protocol-http/
- acpremote: https://pypi.org/project/acpremote/
- acp-ui: https://github.com/formulahendry/acp-ui
- OpenCode ACP over WebSocket: https://github.com/anomalyco/opencode/issues/13388
- AionUi SSH request: https://github.com/iOfficeAI/AionUi/issues/2721
- Zed external agents: https://zed.dev/docs/ai/external-agents
- Zed remote ACP and MCP: https://github.com/zed-industries/zed/issues/52254
- Zed local agent for SSH: https://github.com/zed-industries/zed/discussions/58637
- Zed issues 47910 and 47362: https://github.com/zed-industries/zed/issues/47910, https://github.com/zed-industries/zed/issues/47362
- Remote agent overview (secondary): https://paradev.com/compare/run-coding-agents-on-remote-machine
- Codex serve request: https://github.com/openai/codex/issues/11166
