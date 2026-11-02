# yaah — yet another agent harness

Desktop GUI harness for coding agents. Owners: Filipe, Dennis. Reviewer/approver: Pedro (OOO from Nov 2); backup approver while Pedro is out: **TBD**.
Source: "AI GUI" group DM, 25 Sep – 8 Oct 2026. GitHub org: `yaahdev`.

## Goal
A GUI-first alternative to terminal agents and today's orchestrators (Conductor, Codex/Claude desktop, Atlas, Emdash). Nail a set of shared primitives, then build multiple frontends on top.

## Principles (agreed)
1. Stack: Tauri + TypeScript + React + shadcn.
2. Rust/Tauri owns all backend logic: fs, git, worktrees, commands, session storage, agent comms, ACP.
3. TS is purely presentational; any data comes from an exposed Rust command (state pushed to TS via Tauri events/IPC). Agent-built UI keeps to this: components are declarative data (trees of shadcn-backed primitives) rendered directly in the React tree, never agent-written code. Agent-written TSX, if added, loads only after a person approves that version.
4. Stay close to stock shadcn components so users can theme.
5. Agent communication is ACP-only (no TUI routing).
6. Harness targets: Claude Code, Codex, OpenCode (Pi as an alternative ACP-native option).
7. Primitives are frontend-agnostic and consumed by several frontends.
8. TUI is an anti-goal, but ship a built-in terminal for quick access (not for talking to agents).

## Architecture
- **Rust core (primitives):** ACP client/session manager, git + worktree manager, workspace/session store, file browser, memory, integrations.
- **ACP adapters:** spawn `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`; OpenCode natively. Pin adapter versions (or bundle them) rather than resolving latest via `npx` at runtime; decide whether Node is a user-side requirement. Support multiple accounts per harness (e.g. work/personal).
- **Frontends (on shared primitives):**
  - A. Classic agents view (chat + workspaces, like VS Code agents/Conductor).
  - B. Projects view: orchestrator chat spanning multiple workspaces/repos.

## Platforms & distribution
- Target platforms: **macOS and Linux only.** Windows is out of scope.
- macOS: code signing + notarization. Linux: package formats TBD (AppImage / .deb / .rpm).
- Auto-update (Tauri updater) for both, set up in Phase 0, not at release time.

## Phases

### Phase 0 — Setup (target date: TBD; status as of 2026-11-01: no items ticked yet)
- [ ] Create harness repo under `yaahdev`; Tauri + React + shadcn scaffold. — Owner: TBD
- [ ] CI: build, lint, Rust + TS tests on every PR. — Owner: TBD
- [ ] Release pipeline for macOS (signing + notarization) and Linux packages, with auto-update. — Owner: TBD
- [ ] Track work with GitHub issues + Projects; convert this plan into issues. — Owner: TBD
- [ ] Reuse/review Dennis's POC `dswbx/open-acp` for code and lessons. — Owner: TBD
- [ ] Spike: ACP limits on Claude Code / Codex via adapters. Output: written limitations doc covering: — Owner: TBD
  - planning support (gates Phase 1 Plan UX);
  - multi-account isolation (expected: per-account config dir per harness — confirm for CC and Codex);
  - permission-request and client fs/terminal capabilities each adapter relies on.

### Phase 1 — Core primitives + Frontend A (MVP)
**MVP done when:** a user can open a repo, start a CC/Codex/OpenCode session in its own worktree, chat with it, approve/deny its actions, quit and resume the session later, and have the worktree cleaned up with no orphans.

- [ ] ACP session lifecycle for CC, Codex, OpenCode (spawn, stream, cancel, resume).
- [ ] Session persistence: store sessions/transcripts on disk so resume survives app restarts.
- [ ] Permission requests: surface agent tool-call approval prompts (allow once / always / deny).
- [ ] ACP client capabilities: implement the fs read/write and terminal methods the agent calls on the client (separate from the user-facing terminal).
- [ ] Multi-account support per harness.
- [ ] Chat UI with enriched tool calls, collapse on turn end.
- [ ] Git + worktrees: configurable location, reliable cleanup (no orphans); per-workspace setting for worktree on/off.
- [ ] File explorer, built-in terminal.

### Phase 1.5 — Differentiating UX
- [ ] Review UX for large diffs (not codex-style flat diffs).
- [ ] Plan UX: comment inline on a plan, side-chat/"btw" without context poisoning. *(Conditional on the Phase 0 spike confirming ACP planning support.)*

### Phase 2 — Projects + integrations (Frontend B)
- [ ] Multi-repo projects/initiatives (per-repo worktrees; decide opinionated PR coordination model, watch disk use).
- [ ] Integrations (Linear, GitHub) via OAuth2, used to start a project from a ticket with context preloaded. Desktop app is a public client: decide device flow vs loopback redirect + PKCE before registering the OAuth apps.
- [ ] Optionally expose integrations to agents as MCP from the app.

### Phase 3 — Smarter UI + memory
- [ ] Context-aware components (10 lines vs 10k lines render differently); story-style side panel where a sub-agent walks through large changes.
- [ ] Generative/JIT UI (e.g. Linear overview inside the app). *Started in the PoC (2026-11-01): agents render and build declarative components from a shared library via a yaah MCP server; library is global per user (`~/.yaah/components`) with a source abstraction for team sharing later. Next: approval-gated TSX components.*
- [ ] Memory beyond markdown: SQLite placeholder, fuzzy search, agent-managed deletion.

### Phase 4 — Later / nice-to-haves
- [ ] Model gateway between harness and providers for cost-based routing (jev).
- [ ] Cloud/sandbox execution, web/mobile clients.
- [ ] Orchestrator agent spawning workers.
- [ ] Multiple providers (local/remote).
- [ ] Skills for integrating new ACP harnesses.

## Open questions
| Question | Owner | Decide by |
|---|---|---|
| Worktrees: explicit toggle vs hidden (Dennis: explicit; Filipe: invisible but never a burden). Proposed: per-workspace setting, default on for code repos — confirm and move to Principles. | TBD | TBD |
| Multi-repo project model and PR coordination. | TBD | TBD |
| Memory storage design. | TBD | TBD |
| ACP gaps (planning, accounts, permissions) found in the Phase 0 spike. | TBD | After spike |
| OpenCode vs Pi as the ACP-native reference harness. | TBD | TBD |
| Linux package formats (AppImage / .deb / .rpm). | TBD | TBD |
| Adapter distribution: pinned `npx` vs bundled; Node as a user requirement? | TBD | TBD |
| Desktop OAuth flow: device flow vs loopback + PKCE. | TBD | Before Phase 2 |

## Out of scope (separate tracks from the same chat)
- Spark/Realtime-in-Rust (actor/CSP model, S3 + presence), CVE wall, AI SDK linter (jev/laya).
