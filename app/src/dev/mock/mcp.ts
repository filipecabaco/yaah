// Settings → MCP servers (mcp_servers.rs). Three saved servers (one off, with
// a command that isn't installed) and a few to import. Test answers after a
// moment; a server named "*fail*" (or run with uvx) fails.
import {
  SECRET_MASK as MASK,
  type McpImportCandidate,
  type McpList,
  type McpServer,
  type McpServerDraft,
  type McpServerInfo,
  type McpTestReport,
} from "@/lib/api";
import { home, need, type Mock, type Replies } from "./context";

export function seedMcp() {
  const mcpServers: McpServer[] = [
    {
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", `${home}/notes`],
      env: { NOTES_API_KEY: "ntk_5f2c9a8e7d1b", LOG_LEVEL: "info" },
      url: "",
      headers: {},
      enabled: true,
    },
    {
      name: "linear",
      transport: "sse",
      command: "",
      args: [],
      env: {},
      url: "https://mcp.linear.app/sse",
      headers: { Authorization: "Bearer lin_mock" },
      enabled: true,
    },
    {
      name: "sqlite",
      transport: "stdio",
      command: "uvx",
      args: ["mcp-server-sqlite", "--db-path", `${home}/data.db`],
      env: { SQLITE_READONLY: "1" },
      url: "",
      headers: {},
      enabled: false,
    },
  ];
  return { mcpServers };
}

const candidate = (
  source: string,
  sourceLabel: string,
  path: string,
  original: string,
  name: string,
  transport: McpImportCandidate["transport"],
  target: string,
  envKeys: string[] = [],
  headerKeys: string[] = [],
): McpImportCandidate => ({ source, sourceLabel, path, original, name, transport, target, envKeys, headerKeys, alreadyAdded: false });
const candidates = [
  candidate("claude-code", "Claude Code", "~/.claude.json", "github", "github", "http", "https://api.githubcopilot.com/mcp/", [], ["Authorization"]),
  {
    ...candidate(
      "claude-code",
      "Claude Code",
      "~/.claude.json",
      "filesystem",
      "filesystem-2",
      "stdio",
      `npx -y @modelcontextprotocol/server-filesystem ${home}/notes`,
    ),
    alreadyAdded: true,
  },
  candidate(
    "claude-desktop",
    "Claude Desktop",
    "~/Library/Application Support/Claude/claude_desktop_config.json",
    "Sentry",
    "sentry",
    "stdio",
    "npx -y @sentry/mcp-server",
    ["SENTRY_AUTH_TOKEN"],
  ),
  candidate("cursor", "Cursor", "~/.cursor/mcp.json", "context7", "context7", "http", "https://mcp.context7.com/mcp"),
];

/** Shell-like words: quotes group, and are dropped. */
const split = (line: string) => (line.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^['"]|['"]$/g, ""));

// Secrets, as mcp_servers.rs handles them: the interface only ever gets them masked.
const mask = (v: string) => ([...v].length >= 12 ? `${MASK}${[...v].slice(-4).join("")}` : MASK);
const SECRET_WORDS = [
  "KEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PASS",
  "PWD",
  "AUTH",
  "CREDENTIAL",
  "CREDENTIALS",
  "COOKIE",
  "SESSION",
  "PRIVATE",
  "BEARER",
  "DSN",
];
const PLAIN_HEADERS = ["accept", "accept-language", "content-type", "user-agent", "mcp-protocol-version", "x-request-id"];
function secretEnv(name: string, value: string) {
  const byName = name
    .toUpperCase()
    .split(/[_-]/)
    .some((part) => SECRET_WORDS.some((w) => part.endsWith(w)));
  const urlWithPassword = /^[^:]+:\/\/[^/]*:[^/]*@/.test(value);
  const tokenish =
    value.length >= 20 && !value.includes("://") && !/^[/~.@]/.test(value) && !/\s/.test(value) && /\d/.test(value) && /[a-z]/i.test(value);
  return byName || urlWithPassword || tokenish;
}
const secretHeader = (name: string) => !PLAIN_HEADERS.includes(name.toLowerCase());
function masked(values: Record<string, string>, secret: (k: string, v: string) => boolean): [Record<string, string>, string[]] {
  const keys = Object.entries(values).flatMap(([k, v]) => (secret(k, v) ? [k] : []));
  return [Object.fromEntries(Object.entries(values).map(([k, v]) => [k, keys.includes(k) ? mask(v) : v])), keys];
}
/** The draft with masked values sent back unchanged replaced by the stored ones (`Store::unmask`). */
function unmask(d: McpServerDraft, stored: McpServer | undefined): McpServerDraft {
  const back = (sent: Record<string, string>, kept: Record<string, string> | undefined, what: string) =>
    Object.fromEntries(
      Object.entries(sent).map(([k, v]) => {
        if (!v.startsWith(MASK)) return [k, v];
        const old = kept?.[k.trim()];
        if (old === undefined || mask(old) !== v) throw new Error(`the ${what} \`${k.trim()}\` was hidden; type its value again`);
        return [k, old];
      }),
    );
  return { ...d, env: back(d.env, stored?.env, "environment variable"), headers: back(d.headers, stored?.headers, "header") };
}

const info = (s: McpServer): McpServerInfo => {
  const [env, secretEnvKeys] = masked(s.env, secretEnv);
  const [headers, secretHeaders] = masked(s.headers, secretHeader);
  return {
    ...s,
    env,
    headers,
    secretEnv: secretEnvKeys,
    secretHeaders,
    commandLine: s.command ? [s.command, ...s.args].join(" ") : "",
    problem: s.transport === "stdio" && s.command === "uvx" ? "`uvx` isn't on your PATH, so agents won't get this server" : null,
    unsupportedBy: s.transport === "sse" ? ["Gemini CLI"] : [],
  };
};

/** A server from the editor's draft, checked as mcp_servers.rs checks it. */
function fromDraft(d: McpServerDraft): McpServer {
  const name = d.name.trim();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name))
    throw new Error("names are kebab-case: lowercase letters and digits joined by single dashes, like `github-issues`");
  if (name === "yaah-ui") throw new Error("`yaah-ui` is yaah's own server; pick another name");
  const stdio = d.transport === "stdio";
  const [command = "", ...args] = stdio ? split(d.commandLine) : [];
  if (stdio && !command) throw new Error("enter the command that starts the server");
  if (!stdio && !/^https?:\/\//.test(d.url.trim())) throw new Error("the URL must start with http:// or https://");
  return {
    name,
    transport: d.transport,
    command,
    args,
    env: stdio ? d.env : {},
    url: stdio ? "" : d.url.trim(),
    headers: stdio ? {} : d.headers,
    enabled: d.enabled,
    // Empty means every agent, and is left out as mcp_servers.rs does.
    ...(d.agents.length ? { agents: [...d.agents] } : {}),
  };
}

export function mcpReplies(m: Mock): Replies {
  const { state } = m;
  const taken = (name: string) => state.mcpServers.some((s) => s.name === name);
  const stored = (d: McpServerDraft) => state.mcpServers.find((s) => s.name === (d.original ?? d.name.trim()));
  return {
    list_mcp_servers: (): McpList => ({
      servers: state.mcpServers.map(info),
      builtin: {
        name: "yaah-ui",
        transport: "http",
        about: "yaah's UI tools (forms, tables, charts in the chat). Added for agents that support HTTP MCP.",
      },
      path: `${home}/.config/yaah/mcp.json`,
    }),
    save_mcp_server: ({ draft }: { draft: McpServerDraft }): McpServerInfo => {
      const s = fromDraft(unmask(draft, stored(draft)));
      if (s.name !== draft.original && taken(s.name)) throw new Error(`there's already a server named \`${s.name}\``);
      const i = state.mcpServers.findIndex((x) => x.name === draft.original);
      if (i >= 0) state.mcpServers[i] = s;
      else state.mcpServers.push(s);
      return info(s);
    },
    remove_mcp_server: ({ name }: { name: string }) => {
      state.mcpServers = state.mcpServers.filter((s) => s.name !== name);
      return null;
    },
    set_mcp_server_enabled: ({ name, enabled }: { name: string; enabled: boolean }): McpServerInfo => {
      const s = need(
        state.mcpServers.find((x) => x.name === name),
        `no server named \`${name}\``,
      );
      s.enabled = enabled;
      return info(s);
    },
    test_mcp_server: async ({ draft }: { draft: McpServerDraft }): Promise<McpTestReport> => {
      const s = fromDraft(unmask(draft, stored(draft)));
      await m.wait(900);
      if (s.name.includes("fail") || s.command === "uvx") throw new Error(`\`${s.command || s.url}\` didn't start: command not found`);
      return {
        serverName: s.name === "filesystem" ? "secure-filesystem-server" : s.name,
        serverVersion: "0.6.2",
        protocolVersion: "2025-06-18",
        tools: [
          { name: "read_text_file", description: "Read the complete contents of a file as text." },
          { name: "list_directory", description: "Get a detailed listing of all files and directories in a specified path." },
          { name: "search_files", description: "Recursively search for files and directories matching a pattern." },
          { name: "get_file_info", description: null },
        ],
      };
    },
    mcp_import_candidates: (): McpImportCandidate[] => candidates.map((c) => ({ ...c, alreadyAdded: c.alreadyAdded || taken(c.name) })),
    import_mcp_servers: ({ picks }: { picks: { source: string; original: string }[] }): McpServerInfo[] =>
      picks.map((p) => {
        const c = need(
          candidates.find((x) => x.source === p.source && x.original === p.original),
          `nothing to import as ${p.original} from ${p.source}`,
        );
        const [command = "", ...args] = c.transport === "stdio" ? split(c.target) : [];
        let name = c.name;
        for (let n = 2; taken(name); n++) name = `${c.name}-${n}`;
        const s: McpServer = {
          name,
          transport: c.transport,
          command,
          args,
          env: Object.fromEntries(c.envKeys.map((k) => [k, "mock"])),
          url: c.transport === "stdio" ? "" : c.target,
          headers: Object.fromEntries(c.headerKeys.map((k) => [k, "mock"])),
          enabled: true,
        };
        state.mcpServers.push(s);
        return info(s);
      }),
  };
}
