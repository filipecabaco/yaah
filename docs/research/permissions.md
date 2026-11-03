# Permission prompts across ACP agents

3 November 2026. Research only, no code changed. Sources: yaah's `session.rs` and `entries.tsx`, the installed adapters
under `~/.yaah/agents/` (claude-agent-acp 0.100.0, codex-acp 2.5.0), the ACP spec, and each tool's docs. Items not
checked against a primary source are marked UNVERIFIED. Codex rules files, goose modes, Cursor's allowlist format and
Roo specifics could not be fetched; they are UNVERIFIED or left out.

## The problem

In a real Claude Code chat every Linear/incident.io MCP read, every read-only shell command (`git status`, `grep`, `ls`)
and a `cat >> file` append asked. Each answered prompt then stays as its own "Permission requested ... -> Yes" card
beside the tool card.

## How yaah works today

- **yaah forwards every `session/request_permission` to the user.** Nothing is auto-answered except a "don't ask again"
  the user already gave in this chat (`session.rs`, `respond_permission` and the request handler).
- **"Don't ask again" is a per-chat memory keyed by request title** (a tool name or an exact command), stored in
  `Session.remembered` and not saved across restarts as a rule. It replays the option of the same kind
  (`allow_always`, else `allow_once`). The agent may also remember it its own way.
- **yaah sends no mode or config option.** It never calls `session/set_mode` or `session/set_config_option`.
  `current_mode_update` and config options are ignored (`session.rs`: "not rendered yet").
- **The only pre-approval is for yaah's own UI MCP tools.** For Claude it passes
  `_meta.claudeCode.options.allowedTools` on `session/new` (`add_ui_server`).
- **UI:** `Permission` in `entries.tsx` is a separate transcript entry. Answered ones stay as a card with "-> choice".
  `chat.tsx` already looks up the tool input by `toolCallId` for the card, so the pairing data exists.

### Who decides what

| Decision | Claude Code (claude-agent-acp) | Codex (codex-acp) | yaah |
|---|---|---|---|
| Starting mode | `settings.json` `permissions.defaultMode`, read through `settingSources: user, project, local` | Codex config; adapter default is "Auto review" | nothing |
| Allow/deny rules | `permissions.allow/deny/ask` in the user, project and local settings files | execpolicy rules and sandbox (OS-level) | nothing |
| Read-only auto-allow | Built in: reads in the working dirs and a fixed set of read-only shell commands | Sandbox: reads allowed, writes limited | nothing |
| `allow_always` persistence | Adapter returns a rule to the SDK with destination `localSettings`, so `.claude/settings.local.json` at the git root (adapter source `effects.js`; Claude docs). File edits last only for the session | `acceptForSession` is session-only. "Commands that start with X" is an execpolicy amendment (where it is stored: UNVERIFIED). Host allow/block is a network policy amendment | per-chat memory by title |

Note: the Claude adapter's `buildAvailableModes` never offers `dontAsk`, although `defaultMode: "dontAsk"` is parsed and
then clamped to `default`. `bypassPermissions` is offered unless the process is root. `auto` falls back to `acceptEdits`
on models without Auto.

## What ACP offers

- **Session modes** (`availableModes`, `currentModeId`, `session/set_mode`, `current_mode_update`). The spec says modes
  are being replaced by config options and "will be removed in a future protocol version". Agents should send both and
  keep them in sync. [ACP session modes](https://agentclientprotocol.com/protocol/session-modes)
- **Config options** (`session/set_config_option`, `config_option_update`). An option has a cosmetic `category`:
  `mode`, `model`, `model_config`, `thought_level`. A client should prefer `configOptions` and ignore `modes`.
  [ACP config options](https://agentclientprotocol.com/protocol/session-config-options)
- **Permission option kinds:** `allow_once`, `allow_always`, `reject_once`, `reject_always`. For the `always` kinds the
  agent, not the client, owns the remembered decision and its scope; the option `name` must describe the scope. The
  spec also lets a client "allow or reject automatically based on user settings".
  [ACP tool calls](https://agentclientprotocol.com/protocol/tool-calls)
- **Tool `kind`:** `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`. It is
  a UI hint only.
- **What each adapter advertises (from the installed source):**
  - claude-agent-acp: a `mode` config option plus modes: `default` (Manual), `acceptEdits`, `plan`, `auto`,
    `bypassPermissions`.
  - codex-acp: modes `read-only` (on-request, read-only sandbox), `workspace-write` (on-request), `agent` "Auto review"
    (the default; auto_review reviewer), `agent-full-access` (never ask, no sandbox).
- **Gaps:** MCP `readOnlyHint` is not forwarded by the Claude adapter (no match in its dist). MCP tool calls come
  through as kind `other` in the code I read (UNVERIFIED for every case). So a client cannot tell a read-only MCP tool
  from an ACP message alone. The hint exists in MCP `tools/list` (`readOnlyHint`, default false; it is a hint, not a
  guarantee) [MCP schema](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations), and yaah
  could read it only if it connected to the server itself.

## How others do it

| Tool | Modes / defaults | Rules | Read-only handling | Persistence | Answered-approval UI |
|---|---|---|---|---|---|
| **Claude Code** | `default`/Manual, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`; `defaultMode` in settings | `allow`/`ask`/`deny`; `Bash(git status *)`, `mcp__server__tool`, `mcp__server__*`; deny beats ask beats allow | Reads in working dirs never ask. Built-in read-only shell set (`ls`, `cat`, `grep`, `find`, `git` read forms...), not configurable | Bash and WebFetch rules go to `.claude/settings.local.json`; edits last for the session | Terminal: prompt disappears (UNVERIFIED) |
| **Zed** | `agent.tool_permissions.default`: `confirm` (default) / `allow` / `deny` (older: `always_allow_tool_actions`) | Per tool: `always_allow` / `always_deny` / `always_confirm` regex lists; MCP key `mcp:<server>:<tool>`; compound shell commands split and each part checked; built-in security rules win | None by default | Settings file | Menu on the tool card: Allow once, Always for tool, Always for pattern. Prompt lives on the tool card. For external ACP agents, native permissions "depend on the agent" |
| **Codex CLI** | Sandbox `read-only` / `workspace-write` / `danger-full-access` x policy `on-request` / `never` / granular; "Auto" = workspace-write + on-request; `auto_review` reviewer | execpolicy rules (location UNVERIFIED) | Reads allowed in sandbox; writes limited to workspace; network off by default | Config | UNVERIFIED |
| **Cursor** | Auto-review (recommended), Allowlist, Run Everything | Allowlist only; no hard denylist (`block_instructions` is guidance) | Sandbox: workspace read/write; reads outside default to allowed | `permissions.json` | UNVERIFIED |
| **goose** | autonomous / manual / smart approval (names from memory; page not fetched: UNVERIFIED) | Per tool: Always Allow / Ask Before / Never Allow | User marks read-only tools Always Allow | Config | UNVERIFIED |
| **OpenCode** | Most tools default `allow`; `external_directory` and `doom_loop` default `ask`; `--auto` approves asks | `permission` per tool and per pattern (`"git *": "allow"`); last match wins; agent-level overrides | `read` allowed, `.env` files ask | Config; `always` in a prompt lasts the session | UNVERIFIED |
| **Cline** | Toggles: read project files, edit project files, safe commands, browser, MCP, notifications | "Read all files" / "Edit all files" are separate outside-workspace toggles | The model flags each command `requires_approval`; no fixed list | Settings | UNVERIFIED. Max-requests setting: not on the page |
| **VS Code Copilot** | Permission levels Manual / Assisted (an LLM judge reviews calls) / Allow all | `chat.tools.terminal.autoApprove` (true/false per command or `/regex/`); `chat.tools.urls.autoApprove`; per-MCP-server and per-tool trust via "Manage Tool Approval" | Common read-only terminal commands auto-approved by default; rules match each sub-command; every sub-command must match and a `false` always wins | Approve once, session, workspace or all future calls; "Reset Tool Confirmations" | Not described on the page |

Sources: [Claude Code permissions](https://code.claude.com/docs/en/permissions),
[Zed tool permissions](https://zed.dev/docs/ai/tool-permissions),
[Zed external agents](https://zed.dev/docs/ai/external-agents),
[Codex approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security),
[Cursor run modes](https://cursor.com/docs/agent/run-modes),
[goose tool permissions](https://goose-docs.ai/docs/guides/managing-tools/tool-permissions),
[OpenCode permissions](https://opencode.ai/docs/permissions/),
[Cline auto-approve](https://docs.cline.bot/features/auto-approve),
[VS Code approvals](https://code.visualstudio.com/docs/agents/run/approvals).
Roo Code was not fetched (UNVERIFIED; expected to match Cline).

## Safety

**Safe to auto-allow (by default):**
- Reads and searches inside the chat's own folders. Claude, Codex and OpenCode already do this natively.
- A fixed list of read-only shell commands, judged by an AST, not a regex. Claude Code treats a command as read-only
  only if every sub-command qualifies, and asks if it cannot parse the command. VS Code and Zed split on the same
  operators and require every part to pass, with deny winning.
- MCP tools marked `readOnlyHint: true`, only after the user trusts that server. The hint comes from the server and is
  not enforced, so it is a convenience, not a boundary. Tool-level or server-level trust by the user is the stronger
  signal (Claude `mcp__server__*`, VS Code per-server trust, Zed `mcp:` keys).

**Traps in "safe" shell judgement** (Claude docs, VS Code docs):
- Compound commands: `safe && other`, `;`, `|`, `&`, newlines, subshells, `$(...)`, `for` bodies.
- `cd x && git ...` runs that directory's hooks, so Claude prompts. `cd` with a redirect also prompts.
- Redirects (`> file`, `>>`) turn a read command into a write. `cat >> file` is a write and must ask.
- Unquoted globs with `find`, `sed`, `sort`, `git` can expand into `-delete` or similar flags.
- `ps auxe` prints environment variables; `docker -H` points at another daemon.
- Variables and wrappers (`URL=... && curl $URL`, `sh -c`, `env`, absolute paths) defeat pattern rules. VS Code says
  its parsing is "best-effort, not a security boundary" and bash/zsh/fish share a grammar.
- Cursor says its own classifier "is not a security boundary".

**Must always ask (default):** any write (file edit, redirect), anything outside the chat's folders, network and fetch,
destructive or delete-class commands, installs, git writes, and anything the parser cannot read. Claude refuses to
offer a persistent rule for delete-class asks (`suppressAlwaysAllowRule`), a good model to copy.

## Where the noise comes from, per agent

- **Claude:** the mode is Manual and the user's `settings.json` has no `allow` rules, so MCP reads ask. Its read-only
  shell set should have auto-run `git status`, `grep` and `ls`; if they asked, the likely cause is chained commands
  (`cd` plus `git`, redirects, globs). Which exact commands asked is UNVERIFIED (I did not see the transcript).
- **Codex:** default is Auto review, so it asks little, but the `acceptForSession` option only lasts a session.

## Options

| # | Option | Effort | Notes |
|---|---|---|---|
| A | **Fold the answered prompt into the tool card.** Render a small "Allowed / Denied / Always allowed" chip on the tool card; keep the full card only while pending or if rejected | S | UI only. Data is already paired by `toolCallId`. Nothing is lost: the transcript entry stays, only its rendering changes |
| B | **Show and set the agent's mode.** Read `configOptions` (category `mode`) and `modes` on `session/new`/`load`, show a picker in the composer, call `set_config_option` (fall back to `set_mode`), listen for `config_option_update` and `current_mode_update` | M | Works for every ACP agent that advertises one, with no agent-specific code. Gives Claude `acceptEdits`/`auto` and Codex's presets directly |
| C | **Per-profile / per-project default mode.** Store a preferred mode per profile and optionally per project; apply it after `session/new` if the agent advertises that id. Never default to `bypassPermissions`/`agent-full-access`; those need an explicit, per-chat choice | M | Needs B. Because ids differ by agent, store the id plus agent preset |
| D | **"Trust read-only" default in yaah.** In `request_permission`, auto-select `allow_once` when the tool kind is `read`/`search` and the target is inside the chat's folders; show it as a chip (A) | M | Rust-side. Covers agents with no native read-only rule. Needs path checks (symlinks, `..`) to match how Claude treats them |
| E | **yaah-side rule list** (per project, in yaah's data dir): allow/deny by tool name, MCP `server/tool`, or parsed command prefix; deny wins; saved when the user picks "always" | L | Agent-neutral. Risky parts: shell parsing and the matching fragility described above. Start with exact tool names and MCP server/tool only, no shell patterns |
| F | **Map "always" to the agent's native rule.** For Claude, edit `.claude/settings.local.json` or let the adapter do it (it already does for Bash and WebFetch) | S (already so) | Do not write `settings.json` ourselves; the adapter already persists. yaah only needs to show where it was saved (UNVERIFIED that the option text says so) |
| G | **Use MCP `readOnlyHint`.** Read it where yaah configures the MCP server itself and auto-allow those tools after the user trusts the server | M | The agent adapters do not forward it. Only works for servers yaah lists; skip until E exists |
| H | **Keep persistent "always" scoped to the exact option.** Persist `remembered` per project so it survives restarts | S | Today it is lost on restart; ACP says the agent owns this, so only do this for agents that don't persist (Codex session-only) |

## Recommendation

Do these in order:

1. **A (S) now.** Folding answered prompts into the tool card removes the doubled noise at no safety cost. Keep the
   full card for pending and for rejected requests.
2. **B then C (M each).** Show the agent's own mode picker and let a profile/project pick a default. This is the most
   direct answer to "default permissions" and it stays agent-generic because it only uses ACP modes and config options.
   Prefer `configOptions` and fall back to `modes`, as the spec says. Suggested friendly defaults:
   Claude `acceptEdits` (or `auto` where available), Codex `agent` (already default). Offer the bypass modes only behind
   an explicit per-chat toggle with a warning, never as a stored default.
3. **D (M) as the "trust read-only" default.** Auto-allow `read` and `search` tool kinds inside the chat's folders, shown
   as a chip, with a switch to turn it off. Do not extend it to `execute` or `fetch` yet.
4. **MCP reads:** the practical fix today is the user's own Claude `permissions.allow` rule per server (`mcp__linear__*`)
   or one "always allow" per tool, which the adapter saves to `.claude/settings.local.json`. For yaah, add a
   per-project "trusted MCP servers" list (the first slice of E) so one click covers `get_issue`, `list_comments` and the
   rest, instead of one prompt per tool.
5. **Shell commands:** lean on the agent's native read-only list (Claude, VS Code and Zed already parse them better than
   a yaah regex would). Do not build a yaah shell-command allowlist until E exists, and then match only on a parsed
   first-word prefix with every sub-command checked and deny winning.
6. **Always ask:** writes (including `>>`), anything outside the chat's folders, network, and destructive commands.

Native or in yaah? Use the agent's native mechanism for modes, shell read-only judgement and sandboxing (it knows the
tools and the sandbox, and ACP says it owns `allow_always`). Answer in yaah only for the cases native rules can't
express: auto-allowing `read`/`search` inside the chat's folders for agents that ask anyway, trusted MCP servers, and
the chip that shows what happened.

## Open questions

- Which exact commands asked in the real chat, and was the mode Manual? (UNVERIFIED; check the transcript.)
- Does codex-acp send `read`-kind tool calls for approvals, and where does the execpolicy amendment land? (UNVERIFIED)
- Do other adapters in the ACP registry (goose, OpenCode, Gemini) advertise a mode option? (Not checked; the agent-generic
  rule in B handles either answer.)

## What yaah does now

Implemented on `feat/mdx-permissions-chat-layout`: options A, D, the first slice of E (trusted MCP servers) and H. No
mode switching (B, C) and no shell allowlist.

- **The decision is in Rust** (`app/src-tauri/src/session/permissions.rs`, `decide`). yaah answers a request itself only
  with the request's `allow_once` option, never `allow_always`; with no `allow_once` option it asks. It answers when:
  - the kind is `read` or `search`, it names at least one path (`locations[].path` and the path fields of `rawInput`:
    `file_path`, `path`, `paths`, `notebook_path` and the like), and every path resolves, symlinks and `..` followed,
    inside the chat's folders (cwd, other folders, project repos; `acp_terminals::inside`). A path-like string anywhere
    else in the input (a glob such as `../**` or `/etc/*`, an unknown key) makes it ask. Settings → Chat, "Allow reads in
    the chat's folders without asking", `trustReadOnly` in `settings.json`, on by default;
  - the tool belongs to an MCP server the user trusted (all of its tools: adapters don't forward `readOnlyHint`);
  - the user said "don't ask again" to the same request title in this chat. That replay now also uses the one-off
    option, and the memory is saved with the chat (`SessionInfo.remembered`), so it survives a restart.
- **Identifying the server:** Claude Code (claude-agent-acp 0.99.1 and 0.100.0) sends the tool name `mcp__<server>__<tool>`
  in `toolCall.name` (and `_meta.claudeCode.toolName` in some requests); the title of an MCP tool is the same name, kind
  `other`. A request that names a non-MCP tool (`Bash`) is no server's, whatever its title. Codex (codex-acp 2.5.0) sends
  MCP approvals through an MCP elicitation that falls back to `session/request_permission`: the tool call is titled
  `mcp.<server>.<tool>`, kind `execute`, `rawInput { server, tool, arguments }`, and the approval names only its
  `toolCallId`; an approval it can't tie to a tool call is titled "MCP tool call approval" with
  `_meta.is_mcp_tool_approval` and `rawInput.serverName`. Codex doesn't send `read` or `search` approvals (its sandbox
  allows reads), so the read-only rule is for Claude Code's reads outside its own rules and for other agents. Any other
  shape: no trust action.
- **Trusted servers** are stored per project (`trustedMcpServers` in `projects.json`) or, for a quick chat, with the chat.
  They are listed in the project view and in the chat header, each removable.
- **Transcript:** a permission entry records `answer` (the option kind, or `cancelled`), `auto` (`readOnly`,
  `trustedServer` or `remembered`, with the reason in words) and `mcpServer`. An allowed request isn't drawn on its own;
  its tool card shows "Allowed", "Always allowed" or "Auto-allowed · <reason>". Pending requests keep the full card;
  denied and cancelled ones a one-line card. Old transcripts get `answer` from the chosen option's name when read.
- **Tool-call groups:** two or more tool calls in a row are drawn as one row ("6 tool calls · … · 2 failed · 4
  auto-allowed") that opens to the cards. Text, UI, user messages, pending or denied permissions and edits with a diff end
  a run; a running call stays in sight. Settings → Chat, "Group consecutive tool calls", on by default.
- **Tests:** `session/permissions.rs` (the rule: symlink, `..`, sibling prefix, no paths, every refused kind, lookalike
  servers, each server format), `session/permission_tests.rs` (the handler, persistence across a restart, old
  transcripts), `tests/acp_e2e` (`reads_inside_the_chats_folders_are_allowed_and_everything_else_asks`,
  `trusted_mcp_servers_and_always_survive_a_restart`), and `permissions.test.tsx`, `tool-groups.test.tsx` in the UI.
  Screenshots: `docs/experiments/2026-11-03-permissions/`.
