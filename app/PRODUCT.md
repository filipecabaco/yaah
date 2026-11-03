# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(A Tauri 2 desktop app for macOS and Linux; the interface is a WebKit/WebKitGTK webview.)

## Users

Developers who run coding agents (Claude Code, Codex, Gemini, or any ACP agent) on their own
machine, across one or more repos, often several chats and projects at once. They live in the app
for hours: reading agent output, approving tool calls, reviewing diffs and PRs, poking at data.

## Product Purpose

yaah ("yet another agent harness") is a desktop harness for coding agents. It runs any ACP agent,
groups work into projects and quick chats, and lets the agent answer with real, interactive UI
instead of walls of text. Success: the developer understands and acts on agent work faster than
in a terminal, and the UI the agent builds is something they'd want to keep.

## Positioning

Agents answer with interface. Through yaah's MCP server, an agent renders forms, tables, live PR
views, database explorers, diffs, git graphs and more, built from a shared library of components
that are data, not code, so they render natively and safely. Humans and agents fill in the same
forms together. Components can be saved, versioned, copied, and installed as libraries built by
people and companies.

## Operating Context

- Long working sessions next to an editor and a terminal; keyboard-first (⌘K, ⌘N, ⌘,).
- Agent output streams in; permission prompts interrupt; tool calls pile up.
- Live sources: GitHub, Linear, Postgres (read-only role), Docker, the local system.
- Settings cover agents, MCP servers (global and per agent), skills, integrations, themes,
  component libraries.

## Capabilities and Constraints

- Rust owns logic; the TypeScript UI is presentational.
- ACP is the only channel to run agents; MCP is how agents call back into yaah.
- Stay close to stock shadcn (Tailwind 4); users can theme the app with any VS Code theme, so
  brand moments must survive arbitrary palettes.
- macOS and Linux only. Strict CSP: no remote scripts, fonts or fetches from the app.
- Agent-rendered UI is data rendered by `ui-render.tsx`: no agent code runs.

## Brand Commitments

- Name: "yaah", always lowercase.
- Logo: a mark of four rounded UI tiles locking together into a "y" ("an interface assembling").

## Evidence on Hand

- The yaah component pack (`src-tauri/components/*.json`) and the primitives (`src/ui-primitives.json`).
- A browser mock (`src/dev/browser-mock.ts`) with recorded fixtures for demos.
- No customers, testimonials or metrics; never invent them.

## Product Principles

1. Show, don't tell: the agent's answer is interface the user can act on.
2. The developer stays in control: approvals are explicit, data access is read-only by default.
3. Calm for long sessions: the chrome recedes so agent work stands out.
4. Open: any ACP agent, any theme, anyone's component library.

## Accessibility & Inclusion

Respect `prefers-reduced-motion` everywhere; every animated moment has a static equivalent.
Keyboard access to everything; readable contrast under user themes (theme-map enforces it).
