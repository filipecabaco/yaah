// Agent profiles, presets, test connection and login (agents.rs, login.rs).
// Reports are what each agent answered to `initialize` (OpenCode's is a real one
// from `cargo run --example agent_probe -- opencode`; the others are illustrative).
import type { AgentDraft, AgentPreset, AgentProfile, AgentReport, AuthMethod, ConformanceCheck, ConformanceReport } from "@/lib/api";
import { home, need, now, type Mock, type Replies } from "./context";
import { boundProfiles, withProvider } from "./providers";

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
    listSessions: true,
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
    listSessions: false,
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
const noVersions = {
  package: null,
  pinned: null,
  active: null,
  activeStatus: null,
  advisories: [],
  report: null,
  held: false,
  installed: false,
  latest: null,
  candidate: null,
} satisfies Partial<AgentPreset>;

/** Tier A as it ran on claude-agent-acp 0.99.1 (`cargo run --example conformance`); `broken` replaces one check. */
function tierA(version: string, at: number, broken?: ConformanceCheck): ConformanceReport {
  const checks: ConformanceCheck[] = (
    [
      ["initialize", "answered in 0.2s; advertises loadSession, mcp.http, mcp.sse, systemPrompt, additionalDirectories, embeddedContext, image"],
      ["protocolVersion", `1 (@agentclientprotocol/claude-agent-acp ${version})`],
      ["capability loadSession", "advertised (reopening chats)"],
      ["capability mcpCapabilities.http", "advertised (yaah's UI tools)"],
      ["capability sessionCapabilities.systemPrompt", "advertised (the guide in the system prompt)"],
      ["capability sessionCapabilities.additionalDirectories", "advertised (projects with several folders)"],
      ["capability promptCapabilities.embeddedContext", "advertised (the project brief)"],
      ["authMethods", "claude-ai-login (terminal), console-login (terminal)"],
      ["authMethods terminal args", 'claude-ai-login → ["--cli","auth","login","--claudeai"]'],
      ["unknown method", "method not found (-32601)"],
      ["session/new signed out", "works without a login (session 64fd0ced-8aed-43a4-958c-c4b56c023821)"],
      ["shutdown", "exited (exit status: 0) after stdin closed"],
    ] as const
  ).map(([name, detail]) => (broken?.name === name ? broken : { name, ok: true, detail }));
  return { version, checks, advisories: [], audit: "ok", auditedAt: at, checkedAt: at, seconds: 5.2, promoted: false };
}

const codexRegression: ConformanceCheck = {
  name: "session/new signed out",
  ok: false,
  detail: "expected a session or auth-required (-32000), got unknown field `systemPrompt` (code -32602)",
};

/** npm-based presets (agent_versions.rs): Claude has a newer version being checked, Codex one that failed. */
function versionsOf(id: string, commandLine: string): Partial<AgentPreset> {
  const spec = commandLine.match(/^npx -y (@?[^@\s]+)@(\S+)/);
  if (!spec) return noVersions;
  const [, pkg, pinned] = spec;
  const checkedAt = now() - 3 * 3600;
  const base = { ...noVersions, package: pkg, pinned, active: pinned, activeStatus: "tested" as const, latest: { latest: pinned, checkedAt } };
  if (id === "claude")
    return {
      ...base,
      report: tierA(pinned, checkedAt),
      latest: { latest: "0.100.0", checkedAt },
      candidate: { version: "0.100.0", status: "verifying", checkedAt, failures: [], advisories: [], report: null },
    };
  if (id === "codex")
    return {
      ...base,
      latest: { latest: "2.6.0", checkedAt },
      candidate: {
        version: "2.6.0",
        status: "failed",
        checkedAt,
        failures: [`session/new signed out: ${codexRegression.detail}`],
        advisories: [],
        report: tierA("2.6.0", checkedAt, codexRegression),
      },
    };
  return base;
}

/** A fresh copy per mock install: holds and checks change it. */
function seedPresets(): AgentPreset[] {
  return presetRows.map(([id, label, blurb, via, path, commandLine, docs]) => ({
    id,
    label,
    blurb,
    docs,
    via,
    path,
    install: via === "missing" ? `See the ${label} docs for install options.` : "",
    draft: { id: null, label: id === "custom" ? "My agent" : label, preset: id, commandLine, env: {}, configDir: null },
    providers: ["claude", "goose", "opencode"].includes(id) ? (["bedrock", "openrouter"] as const).slice() : [],
    ...noVersions,
    ...versionsOf(id, commandLine),
  }));
}

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
        ...boundProfiles(),
      ];
  return { profiles, defaultAgent: firstRun ? null : ("default" as string | null), presets: seedPresets() };
}

function fromDraft(d: AgentDraft, id: string, presets: AgentPreset[]): AgentProfile {
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
    list_agents: () => ({
      profiles: state.profiles.map((p) => withProvider(state, p)),
      defaultId: state.defaultAgent ?? state.profiles[0]?.id ?? null,
    }),
    list_agent_presets: async (): Promise<AgentPreset[]> => {
      await m.wait(400);
      return state.presets;
    },
    // A hold freezes the active version; releasing it goes back to the pin (nothing newer is verified here).
    hold_agent_version: ({ preset, version }: { preset: string; version: string | null }) => {
      const p = need(
        state.presets.find((x) => x.id === preset && x.pinned),
        `unknown agent preset ${preset}`,
      );
      if (version !== null && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
        throw new Error(`\`${version}\` isn't an exact version such as 1.2.3`);
      const before = p.active;
      const next = {
        ...p,
        held: version !== null,
        active: version ?? p.pinned,
        activeStatus: version && version !== p.pinned ? ("installed" as const) : ("tested" as const),
      };
      state.presets = state.presets.map((x) => (x.id === preset ? next : x));
      // Claude's default profile is "running" in the mock.
      const running = next.active !== before && preset === "claude" && state.profiles.some((x) => x.id === "default") ? ["default"] : [];
      return { presets: state.presets, running };
    },
    check_agent_updates: async () => {
      await m.wait(300);
      state.presets = state.presets.map((p) => (p.latest ? { ...p, latest: { ...p.latest, checkedAt: now() } } : p));
      return state.presets;
    },
    // Claude's candidate passes and is promoted; Codex's fails the same way again; anything else passes.
    verify_agent_version: async ({ preset, version }: { preset: string; version: string }) => {
      await m.wait(600);
      const p = need(
        state.presets.find((x) => x.id === preset && x.pinned),
        `unknown agent preset ${preset}`,
      );
      const isCandidate = p.candidate?.version === version;
      const report = { ...tierA(version, now(), preset === "codex" && isCandidate ? codexRegression : undefined), seconds: 4.8 };
      const passed = report.checks.every((c) => c.ok);
      report.promoted = isCandidate && passed;
      const next: AgentPreset = report.promoted
        ? { ...p, active: version, activeStatus: "verified", report, candidate: null }
        : isCandidate && p.candidate
          ? {
              ...p,
              candidate: {
                ...p.candidate,
                status: passed ? "verifying" : "failed",
                checkedAt: now(),
                failures: report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
                report,
              },
            }
          : { ...p, report };
      state.presets = state.presets.map((x) => (x.id === preset ? next : x));
      return { report, presets: state.presets };
    },
    restart_agents: async () => {
      await changed();
      return null;
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
      const p: AgentProfile = {
        ...fromDraft(d, id, state.presets),
        report: old && old.commandLine === d.commandLine.trim() ? old.report : null,
        ...(old?.provider ? { provider: old.provider } : {}),
      };
      state.profiles = old ? state.profiles.map((x) => (x.id === id ? p : x)) : [...state.profiles, p];
      state.defaultAgent ??= id;
      await changed();
      return withProvider(state, p);
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
      if (state.presets.find((p) => p.id === d.preset)?.via === "missing" && command !== "npx")
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
