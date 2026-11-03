// Agent profiles, presets, test connection and login (agents.rs, login.rs).
// Reports are what each agent answered to `initialize` (OpenCode's is a real one
// from `cargo run --example agent_probe -- opencode`; the others are illustrative).
import type { AgentDraft, AgentPreset, AgentProfile, AgentReport, AuthMethod } from "@/lib/api";
import { home, now, type Mock, type Replies } from "./context";

const claudeAdapter = "npx -y @agentclientprotocol/claude-agent-acp@0.99.1";

const reports: Record<string, Omit<AgentReport, "checkedAt">> = {
  claude: {
    name: "@agentclientprotocol/claude-agent-acp",
    title: "Claude Agent",
    version: "0.99.1",
    protocolVersion: 1,
    compatible: true,
    authMethods: [{ id: "claude-login", name: "Log in with Claude", description: "Opens claude.ai in your browser", kind: "terminal", vars: [] }],
    mcpHttp: true,
    mcpSse: true,
    loadSession: true,
    embeddedContext: true,
    image: true,
    audio: false,
    additionalDirs: true,
    systemPrompt: true,
  },
  gemini: {
    name: "gemini-cli",
    title: "Gemini CLI",
    version: "0.63.0",
    protocolVersion: 1,
    compatible: true,
    authMethods: [
      { id: "oauth-personal", name: "Log in with Google", description: null, kind: "agent", vars: [] },
      {
        id: "gemini-api-key",
        name: "Use Gemini API key",
        description: "Requires setting the `GEMINI_API_KEY` environment variable",
        kind: "agent",
        vars: [],
      },
    ],
    mcpHttp: true,
    mcpSse: true,
    loadSession: true,
    embeddedContext: true,
    image: true,
    audio: true,
    additionalDirs: false,
  },
  opencode: {
    name: "OpenCode",
    title: null,
    version: "1.16.2",
    protocolVersion: 1,
    compatible: true,
    authMethods: [
      { id: "opencode-login", name: "Login with opencode", description: "Run `opencode auth login` in the terminal", kind: "agent", vars: [] },
    ],
    mcpHttp: true,
    mcpSse: true,
    loadSession: true,
    embeddedContext: true,
    image: true,
    audio: false,
    additionalDirs: false,
  },
  kimi: {
    name: "kimi-cli",
    title: "Kimi CLI",
    version: "1.52.0",
    protocolVersion: 1,
    compatible: true,
    authMethods: [{ id: "kimi-key", name: "API key", description: null, kind: "env_var", vars: ["MOONSHOT_API_KEY"] }],
    mcpHttp: false,
    mcpSse: false,
    loadSession: false,
    embeddedContext: false,
    image: false,
    audio: false,
    additionalDirs: false,
  },
};

const npx = `${home}/.local/share/mise/installs/node/latest/bin/npx`;
// id, label, blurb, how it's found, path, command line, docs
const presetRows: [string, string, string, AgentPreset["via"], string | null, string, string][] = [
  [
    "claude",
    "Claude Code",
    "Anthropic's Claude Code, through the ACP adapter.",
    "npx",
    npx,
    claudeAdapter,
    "https://github.com/agentclientprotocol/claude-agent-acp",
  ],
  [
    "gemini",
    "Gemini CLI",
    "Google's Gemini CLI in ACP mode.",
    "binary",
    `${home}/.local/share/mise/installs/npm-google-gemini-cli/latest/node_modules/.bin/gemini`,
    "gemini --acp",
    "https://github.com/google-gemini/gemini-cli",
  ],
  [
    "codex",
    "Codex",
    "OpenAI Codex, through the codex-acp adapter (it bundles Codex).",
    "npx",
    npx,
    "npx -y @agentclientprotocol/codex-acp@2.5.0",
    "https://github.com/agentclientprotocol/codex-acp",
  ],
  [
    "opencode",
    "OpenCode",
    "OpenCode's built-in ACP server.",
    "binary",
    `${home}/.opencode/bin/opencode`,
    "opencode acp",
    "https://opencode.ai/docs/acp/",
  ],
  ["goose", "goose", "Block's goose, using your goose providers and extensions.", "missing", null, "goose acp", "https://github.com/block/goose"],
  [
    "copilot",
    "GitHub Copilot",
    "GitHub Copilot CLI's ACP server (public preview).",
    "npx",
    npx,
    "npx -y @github/copilot@1.0.105 --acp",
    "https://github.blog/changelog/2026-01-28-acp-support-in-copilot-cli-is-now-in-public-preview/",
  ],
  ["cursor", "Cursor", "Cursor's agent CLI in ACP mode.", "missing", null, "cursor-agent acp", "https://cursor.com/docs/cli/acp"],
  ["kiro", "Kiro CLI", "Amazon's Kiro CLI in ACP mode.", "missing", null, "kiro-cli acp", "https://kiro.dev/docs/cli/acp/"],
  ["kimi", "Kimi CLI", "Moonshot's Kimi CLI in ACP mode.", "binary", `${home}/.local/bin/kimi`, "kimi acp", "https://github.com/MoonshotAI/kimi-cli"],
  ["custom", "Custom command", "Any agent that speaks ACP on stdio.", "custom", null, "", "https://agentclientprotocol.com/overview/agents"],
];
const presets: AgentPreset[] = presetRows.map(([id, label, blurb, via, path, commandLine, docs]) => ({
  id,
  label,
  blurb,
  docs,
  via,
  path,
  install: via === "missing" ? `See the ${label} docs for install options.` : "",
  draft: { id: null, label: id === "custom" ? "My agent" : label, preset: id, commandLine, env: {}, configDir: null },
}));

const claudeProfile = (id: string, label: string, configDir: string | null, email: string | null): AgentProfile => ({
  id,
  label,
  preset: "claude",
  command: "npx",
  args: ["-y", "@agentclientprotocol/claude-agent-acp@0.99.1"],
  env: {},
  configDir,
  report: null,
  commandLine: claudeAdapter,
  presetLabel: "Claude Code",
  email,
  loggedIn: email !== null,
  installed: true,
});

/** Three Claude profiles (one not logged in), or none on first run (the setup screen). */
export function seedAgents(firstRun: boolean) {
  const profiles: AgentProfile[] = firstRun
    ? []
    : [
        { ...claudeProfile("default", "Claude", null, "dev@example.com"), report: { ...reports.claude, checkedAt: now() - 3600 } },
        claudeProfile("work", "Claude (work)", `${home}/.claude-work`, "dev@work.example"),
        claudeProfile("personal", "Claude (personal)", `${home}/.claude-personal`, null),
      ];
  return { profiles, defaultAgent: firstRun ? null : ("default" as string | null) };
}

function fromDraft(d: AgentDraft, id: string): AgentProfile {
  const [command = "", ...args] = d.commandLine.trim().split(/\s+/);
  const preset = presets.find((p) => p.id === d.preset);
  return {
    id,
    label: d.label.trim(),
    preset: d.preset,
    command,
    args,
    env: d.env,
    configDir: d.preset === "claude" ? d.configDir : null,
    report: null,
    commandLine: d.commandLine.trim(),
    presetLabel: preset?.label ?? "Custom",
    email: null,
    loggedIn: d.preset === "claude" ? false : null,
    installed: preset ? preset.via !== "missing" : true,
  };
}

export function agentReplies(m: Mock): Replies {
  const { state } = m;
  const changed = () => m.emit("accounts-changed", null);
  return {
    list_agents: () => ({ profiles: state.profiles, defaultId: state.defaultAgent ?? state.profiles[0]?.id ?? null }),
    list_agent_presets: async (): Promise<AgentPreset[]> => {
      await m.wait(400);
      return presets;
    },
    save_agent: async ({ draft: d }: { draft: AgentDraft }): Promise<AgentProfile> => {
      if (!d.label.trim()) throw new Error("give the agent a name");
      if (!d.commandLine.trim()) throw new Error("enter the command that starts the agent");
      const base =
        d.label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "agent";
      let id = d.id ?? base;
      for (let n = 2; !d.id && state.profiles.some((p) => p.id === id); n++) id = `${base}-${n}`;
      const old = state.profiles.find((p) => p.id === id);
      // A test result stays valid while the command doesn't change.
      const p = { ...fromDraft(d, id), report: old && old.commandLine === d.commandLine.trim() ? old.report : null };
      state.profiles = old ? state.profiles.map((x) => (x.id === id ? p : x)) : [...state.profiles, p];
      state.defaultAgent ??= id;
      await changed();
      return p;
    },
    remove_agent: async ({ id }: { id: string }) => {
      state.profiles = state.profiles.filter((p) => p.id !== id);
      if (state.defaultAgent === id) state.defaultAgent = state.profiles[0]?.id ?? null;
      await changed();
      return null;
    },
    set_default_agent: async ({ id }: { id: string }) => {
      state.defaultAgent = id;
      await changed();
      return null;
    },
    test_agent: async ({ draft: d }: { draft: AgentDraft }): Promise<AgentReport> => {
      await m.wait(1200);
      const command = d.commandLine.trim().split(/\s+/)[0];
      if (presets.find((p) => p.id === d.preset)?.via === "missing" && command !== "npx")
        throw new Error(`failed to start \`${command}\`: No such file or directory (os error 2). Is it installed and on your PATH?`);
      const known = reports[d.preset];
      if (!known) throw new Error("initialize failed: agent process exited:\nerror: unknown flag --acp");
      const report = { ...known, checkedAt: now() };
      if (d.id) state.profiles = state.profiles.map((p) => (p.id === d.id ? { ...p, report } : p));
      return report;
    },
    login_methods: ({ accountId }: { accountId: string }): AuthMethod[] => {
      const p = state.profiles.find((x) => x.id === accountId);
      return (p && reports[p.preset]?.authMethods) ?? [];
    },
    // The browser sign-in "finishes" after a moment.
    start_login: async ({ accountId }: { accountId: string }) => {
      await m.wait(2500);
      state.profiles = state.profiles.map((p) =>
        p.id === accountId ? { ...p, loggedIn: p.preset === "claude" ? true : null, email: p.preset === "claude" ? "dev@example.com" : null } : p,
      );
      await m.emit("login-done", { accountId, ok: true, message: null });
      await changed();
      return null;
    },
    cancel_login: () => null,
    submit_login_code: () => null,
  };
}
