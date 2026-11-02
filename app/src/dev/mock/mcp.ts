// Settings → MCP servers (mcp_servers.rs). Three saved servers (one off, with
// a command that isn't installed) and a few to import. Test answers after a
// moment; a server named "*fail*" (or run with uvx) fails.
import type { McpImportCandidate, McpList, McpServer, McpServerDraft, McpServerInfo, McpTestReport } from "@/lib/api";
import { home, need, type Mock, type Replies } from "./context";

export function seedMcp() {
  const mcpServers: McpServer[] = [
    {
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", `${home}/notes`],
      env: {},
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

const info = (s: McpServer): McpServerInfo => ({
  ...s,
  commandLine: s.command ? [s.command, ...s.args].join(" ") : "",
  problem: s.transport === "stdio" && s.command === "uvx" ? "`uvx` isn't on your PATH, so agents won't get this server" : null,
  unsupportedBy: s.transport === "sse" ? ["Gemini CLI"] : [],
});

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
      const s = fromDraft(draft);
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
      const s = fromDraft(draft);
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
