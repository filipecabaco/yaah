// Typed bindings to the Rust core. Mirrors `src-tauri/src/{agents,projects,login,session}.rs`.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** A login method an agent offers (ACP `authMethods`). */
export type AuthMethod = {
  id: string;
  name: string;
  description: string | null;
  /** "agent": the agent logs in itself; "terminal": yaah reruns the agent command; "env_var": set `vars`. */
  kind: "agent" | "terminal" | "env_var" | (string & {});
  vars: string[];
};

/** What an agent said in ACP `initialize`. */
export type AgentReport = {
  name: string | null;
  title: string | null;
  version: string | null;
  protocolVersion: number | null;
  /** yaah speaks this protocol version. */
  compatible: boolean;
  authMethods: AuthMethod[];
  /** Can reach HTTP MCP servers, so yaah's UI tools work in its chats. */
  mcpHttp: boolean;
  mcpSse: boolean;
  loadSession: boolean;
  embeddedContext: boolean;
  image: boolean;
  audio: boolean;
  additionalDirs: boolean;
  checkedAt: number;
};

/** An agent profile: an ACP agent command yaah runs chats with. Chats store its id as `accountId`. */
export type AgentProfile = {
  id: string;
  label: string;
  preset: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Claude only: CLAUDE_CONFIG_DIR (absent = ~/.claude). */
  configDir?: string | null;
  report?: AgentReport | null;
  commandLine: string;
  presetLabel: string;
  /** Claude: the logged-in account. */
  email: string | null;
  /** false when the agent needs a login; null when yaah can't tell yet. */
  loggedIn: boolean | null;
  installed: boolean;
};

/** What the setup screen edits, saves and tests. */
export type AgentDraft = {
  id: string | null;
  label: string;
  preset: string;
  commandLine: string;
  env: Record<string, string>;
  configDir: string | null;
};

export type AgentPreset = {
  id: string;
  label: string;
  blurb: string;
  docs: string;
  install: string;
  via: "binary" | "npx" | "missing" | "custom";
  path: string | null;
  draft: AgentDraft;
};

/** Chats can start unless the agent is known to need a login. */
export const canChat = (agent: AgentProfile | undefined | null): agent is AgentProfile => !!agent && agent.loggedIn !== false;

export type ProjectStatus = "planning" | "ongoing" | "done" | "archived";
export const PROJECT_STATUSES: ProjectStatus[] = ["planning", "ongoing", "done", "archived"];

export type Project = {
  id: string;
  name: string;
  dirs: string[];
  status: ProjectStatus;
  createdAt: number;
  contextDir: string;
};

export type Repo = {
  name: string;
  path: string;
  /** `owner/repo` of origin, or the raw remote URL. */
  remote: string | null;
  branch: string | null;
};

export type SessionInfo = {
  sessionId: string;
  /** null for a quick chat outside any project. */
  projectId: string | null;
  /** Unix seconds (0 for older chats). */
  createdAt: number;
  accountId: string;
  cwd: string;
  additionalDirs: string[];
  title: string;
  running: boolean;
  stopReason: string | null;
  /** Slash commands the agent offers in this chat. */
  commands: SlashCommand[];
};

export type SlashCommand = { name: string; description: string; input?: { hint?: string } | null };

export type Appearance = "system" | "light" | "dark";
export type GeneralSettings = {
  appearance: Appearance;
  /** Theme ids for light and dark mode: "yaah", "shiki:<name>" or "custom:<file>". */
  theme: { light: string; dark: string };
  /** How tool cards open in chats, by kind of tool (defaults plus your own rules). */
  toolCards: { rules: Record<string, "auto" | "collapsed" | "expanded">; defaults: { key: string; mode: string }[] };
  /** VS Code themes dropped in ~/.config/yaah/themes. */
  customThemes: { file: string; label: string; type: string | null }[];
  workspaceRoots: string[];
  dataDirs: { label: string; path: string; about: string; exists: boolean }[];
  version: string;
};

/** A service yaah reads for the user (GitHub, Linear), as Settings shows it. */
export type IntegrationStatus = {
  id: string;
  label: string;
  about: string;
  flow: "device" | "browser";
  connected: boolean;
  /** oauth, key or env (a token in the environment). */
  via: "" | "oauth" | "key" | "env";
  account: string | null;
  needsReauth: boolean;
  keyEnv: string;
  keyUrl: string;
};
export type IntegrationStart =
  { flow: "device"; userCode: string; verificationUri: string; expiresIn: number } | { flow: "browser"; authUrl: string };

/** A database connection as the app shows it: never the credentials. */
export type ConnectionInfo = { name: string; kind: string; target: string };

export type FileMatch = { path: string; label: string };

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | (string & {});
};

export type ToolContent =
  | { type: "content"; content: { type: string; text?: string } }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export type PlanItem = {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
};

export type Entry =
  | { type: "user"; text: string; attachments: string[] }
  | { type: "agent"; text: string; messageId: string | null }
  | { type: "thought"; text: string; messageId: string | null }
  | {
      type: "tool";
      toolCallId: string;
      title: string;
      kind: string | null;
      status: "pending" | "in_progress" | "completed" | "failed" | null;
      content: ToolContent[];
      locations: { path: string; line?: number | null }[];
      rawInput: unknown;
    }
  | { type: "plan"; entries: PlanItem[] }
  | {
      type: "permission";
      requestId: unknown;
      toolCallId: string | null;
      title: string;
      options: PermissionOption[];
      chosen: string | null;
    }
  | {
      type: "ui";
      /** Set when the agent is waiting on this UI's form (ui_ask). */
      askId: string | null;
      /** What the user submitted; locks the form. */
      answer: unknown;
      /** Unsent values the user and the agent both edit. */
      draft?: Record<string, unknown>;
      /** Who changed each draft field last. */
      draftBy?: Record<string, "user" | "agent">;
      title: string | null;
      component: string | null;
      version: number | null;
      tree: unknown;
      props: Record<string, unknown>;
    }
  | { type: "error"; message: string; loginAccount: string | null }
  | { type: "notices"; items: Notice[] };

/** Something the agent flagged outside its reply (ACP `notice`). */
export type Notice = { severity: "info" | "warning" | "error" | (string & {}); title: string; description?: string; mcpServer?: string };

/** A library component (see src-tauri/src/ui_library.rs). */
export type UiComponent = {
  name: string;
  version: number;
  description: string;
  props: Record<string, unknown>;
  tree: unknown;
  examples: { title: string; props: Record<string, unknown> }[];
  changeNote: string | null;
  updatedAt: number;
  source: string;
  /** Libraries it is built on (derived from its primitives). */
  uses: string[];
};

// Skills (Settings → Skills). Mirrors `src-tauri/src/skills.rs`.
/** Where a skill yaah installed came from (its `.yaah-source.json`). */
export type SkillSource = { repo: string; ref: string; path: string; sha: string; installedAt: number };
export type InstalledSkill = {
  name: string;
  description: string;
  folder: string;
  dir: string;
  files: number;
  /** A symlinked folder: Remove deletes only the link. */
  linked: boolean;
  source: SkillSource | null;
  problem: string | null;
};
export type SkillAgent = { id: string; label: string; preset: string };
/** A skills folder and the agent profiles that read it. */
export type SkillLocation = { dir: string; label: string; agents: SkillAgent[]; docs: string; exists: boolean; skills: InstalledSkill[] };
export type SkillsOverview = {
  locations: SkillLocation[];
  defaultTarget: string | null;
  /** Profiles whose agent has no confirmed skills folder. */
  unsupported: SkillAgent[];
  suggested: { repo: string; about: string }[];
};
export type FoundSkill = {
  path: string;
  folder: string;
  name: string;
  description: string;
  files: number;
  bytes: number;
  /** Symlinks and submodules left out. */
  skipped: string[];
  /** Why it can't be installed. */
  problem: string | null;
  /** Skills folders that already have a folder by this name. */
  installedIn: string[];
};
export type SkillLookup = { repo: string; ref: string; sha: string; path: string; skills: FoundSkill[]; authenticated: boolean; notes: string[] };
export type SkillInstallRequest = { repo: string; ref: string; sha: string; paths: string[]; target: string; replace: boolean };
export type SkillInstalled = { path: string; folder: string; dir: string | null; error: string | null };

export const api = {
  // agents & login
  listAgents: () => invoke<{ profiles: AgentProfile[]; defaultId: string | null }>("list_agents"),
  listAgentPresets: () => invoke<AgentPreset[]>("list_agent_presets"),
  saveAgent: (draft: AgentDraft) => invoke<AgentProfile>("save_agent", { draft }),
  removeAgent: (id: string) => invoke<void>("remove_agent", { id }),
  setDefaultAgent: (id: string) => invoke<void>("set_default_agent", { id }),
  /** Start the agent, run ACP `initialize`, report. Never logs in or opens a session. */
  testAgent: (draft: AgentDraft) => invoke<AgentReport>("test_agent", { draft }),
  loginMethods: (accountId: string) => invoke<AuthMethod[]>("login_methods", { accountId }),
  startLogin: (accountId: string, methodId: string) => invoke<void>("start_login", { accountId, methodId }),
  submitLoginCode: (accountId: string, code: string) => invoke<void>("submit_login_code", { accountId, code }),
  cancelLogin: (accountId: string) => invoke<void>("cancel_login", { accountId }),

  // projects
  listProjects: () => invoke<Project[]>("list_projects"),
  createProject: (name: string, dirs: string[]) => invoke<Project>("create_project", { name, dirs }),
  renameProject: (id: string, name: string) => invoke<Project>("rename_project", { id, name }),
  setProjectStatus: (id: string, status: ProjectStatus) => invoke<Project>("set_project_status", { id, status }),
  addProjectDirs: (id: string, dirs: string[]) => invoke<Project>("add_project_dirs", { id, dirs }),

  // repos
  listRepos: () => invoke<{ roots: string[]; repos: Repo[] }>("list_repos"),
  setWorkspaceRoots: (roots: string[]) => invoke<string[]>("set_workspace_roots", { roots }),
  cloneRepo: (source: string, root: string) => invoke<Repo>("clone_repo", { source, root }),
  removeProjectDir: (id: string, dir: string) => invoke<Project>("remove_project_dir", { id, dir }),
  deleteProject: (id: string) => invoke<void>("delete_project", { id }),
  readBrief: (id: string) => invoke<string>("read_brief", { id }),
  writeBrief: (id: string, text: string) => invoke<void>("write_brief", { id, text }),

  // sources (data the app reads itself) and database connections
  readSource: (source: unknown) => invoke<unknown>("read_source", { source }),
  // integrations (Settings → Integrations): never returns a token
  integrationsStatus: () => invoke<IntegrationStatus[]>("integrations_status"),
  integrationConnect: (service: string) => invoke<IntegrationStart>("integration_connect", { service }),
  integrationSetKey: (service: string, key: string) => invoke<{ account: string }>("integration_set_key", { service, key }),
  integrationDisconnect: (service: string) => invoke<void>("integration_disconnect", { service }),
  // Settings → General
  generalSettings: () => invoke<GeneralSettings>("general_settings"),
  setAppearance: (appearance: Appearance) => invoke<void>("set_appearance", { appearance }),
  setTheme: (light: string, dark: string) => invoke<void>("set_theme", { light, dark }),
  setToolCard: (key: string, mode: string | null) => invoke<void>("set_tool_card", { key, mode }),
  readCustomTheme: (name: string) =>
    invoke<{ name?: string; displayName?: string; type?: string; colors: Record<string, string> }>("read_custom_theme", { name }),
  revealDataDir: (path: string) => invoke<void>("reveal_data_dir", { path }),
  listConnections: () => invoke<ConnectionInfo[]>("list_connections"),
  addConnection: (name: string, url: string) => invoke<ConnectionInfo>("add_connection", { name, url }),
  removeConnection: (name: string) => invoke<void>("remove_connection", { name }),

  // skills (Settings → Skills)
  listSkills: () => invoke<SkillsOverview>("list_skills"),
  /** `owner/repo`, `owner/repo/path` or a github.com link: every folder with a SKILL.md, previewed. */
  skillsLookup: (input: string) => invoke<SkillLookup>("skills_lookup", { input }),
  skillsInstall: (request: SkillInstallRequest) => invoke<SkillInstalled[]>("skills_install", { request }),
  /** Re-fetch a yaah-installed skill from the latest commit of its branch. */
  skillsUpdate: (dir: string) => invoke<{ updated: boolean; sha: string }>("skills_update", { dir }),
  skillsRemove: (dir: string) => invoke<void>("skills_remove", { dir }),

  // UI component library
  listComponents: () => invoke<UiComponent[]>("list_components"),
  previewComponent: (name: string, props: Record<string, unknown>) =>
    invoke<{ tree: unknown; props: Record<string, unknown> }>("preview_component", { name, props }),

  // chats
  listSessions: () => invoke<SessionInfo[]>("list_sessions"),
  newSession: (projectId: string, accountId: string) => invoke<SessionInfo>("new_session", { projectId, accountId }),
  /** A chat outside any project: in `dir`, or a fresh scratch folder. */
  newQuickChat: (accountId: string, dir?: string) => invoke<SessionInfo>("new_quick_chat", { accountId, dir: dir ?? null }),
  setChatProject: (sessionId: string, projectId: string | null) => invoke<SessionInfo>("set_chat_project", { sessionId, projectId }),
  /** Make a project from a chat's folder and file the chat under it. */
  promoteChat: (sessionId: string, name: string) => invoke<[Project, SessionInfo]>("promote_chat", { sessionId, name }),
  getTranscript: (sessionId: string) => invoke<{ info: SessionInfo; entries: Entry[] }>("get_transcript", { sessionId }),
  /** `mentions`: absolute paths referenced with @, sent to the agent as file links. */
  /** Submit the form in the UI entry at `index`. */
  answerUi: (sessionId: string, index: number, values: Record<string, unknown>) => invoke<void>("answer_ui", { sessionId, index, values }),
  /** Change fields of an unsent form (the agent edits the same draft). */
  editUi: (sessionId: string, index: number, values: Record<string, unknown>) => invoke<unknown>("edit_ui", { sessionId, index, values }),
  sendPrompt: (sessionId: string, text: string, mentions: string[] = []) => invoke<void>("send_prompt", { sessionId, text, mentions }),
  renameSession: (sessionId: string, title: string) => invoke<SessionInfo>("rename_session", { sessionId, title }),
  deleteSession: (sessionId: string) => invoke<void>("delete_session", { sessionId }),
  searchFiles: (sessionId: string, query: string, limit = 30) => invoke<FileMatch[]>("search_files", { sessionId, query, limit }),
  cancelTurn: (sessionId: string) => invoke<void>("cancel_turn", { sessionId }),
  respondPermission: (sessionId: string, index: number, optionId: string | null) =>
    invoke<void>("respond_permission", { sessionId, index, optionId }),
};

function on<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => cb(e.payload));
}

export const events = {
  sessionEntry: (cb: (e: { sessionId: string; index: number; entry: Entry }) => void) => on("session-entry", cb),
  sessionInfo: (cb: (info: SessionInfo) => void) => on("session-info", cb),
  accountsChanged: (cb: () => void) => on("accounts-changed", cb),
  loginOutput: (cb: (e: { accountId: string; line: string }) => void) => on("login-output", cb),
  loginUrl: (cb: (e: { accountId: string; url: string }) => void) => on("login-url", cb),
  loginDone: (cb: (e: { accountId: string; ok: boolean; message: string | null }) => void) => on("login-done", cb),
};

// ── MCP servers (Settings → MCP servers). Mirrors `src-tauri/src/mcp_servers.rs`. ──
// Handed to every agent yaah starts, in ACP `session/new` / `session/load` `mcpServers`.

export type McpTransport = "stdio" | "http" | "sse";
export type McpServer = {
  /** kebab-case, unique, never `yaah-ui`. */
  name: string;
  transport: McpTransport;
  /** stdio */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** http / sse */
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  /** Agent profiles that get it; missing or empty: every agent. */
  agents?: string[];
};
export type McpServerInfo = McpServer & {
  commandLine: string;
  /** Why no agent gets it right now (a stdio command not on PATH). */
  problem: string | null;
  /** Saved agents whose last `initialize` said they can't use this transport. */
  unsupportedBy: string[];
};
export type McpServerDraft = {
  /** The saved name, when editing (allows renaming). */
  original: string | null;
  name: string;
  transport: McpTransport;
  commandLine: string;
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  /** Agent profiles that get it; empty: every agent. */
  agents: string[];
};
export type McpList = {
  servers: McpServerInfo[];
  builtin: { name: string; transport: McpTransport; about: string };
  path: string;
};
export type McpTestReport = {
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  tools: { name: string; description: string | null }[];
};
/** A server found in another tool's config. Carries no env or header values. */
export type McpImportCandidate = {
  source: string;
  sourceLabel: string;
  path: string;
  original: string;
  /** The name it gets in yaah. */
  name: string;
  transport: McpTransport;
  /** Command line, or the URL without its query string. */
  target: string;
  envKeys: string[];
  headerKeys: string[];
  alreadyAdded: boolean;
};

export const mcpApi = {
  list: () => invoke<McpList>("list_mcp_servers"),
  save: (draft: McpServerDraft) => invoke<McpServerInfo>("save_mcp_server", { draft }),
  remove: (name: string) => invoke<void>("remove_mcp_server", { name }),
  setEnabled: (name: string, enabled: boolean) => invoke<McpServerInfo>("set_mcp_server_enabled", { name, enabled }),
  /** Connect (20s limit), initialize, list tools. Works on unsaved drafts. */
  test: (draft: McpServerDraft) => invoke<McpTestReport>("test_mcp_server", { draft }),
  importCandidates: () => invoke<McpImportCandidate[]>("mcp_import_candidates"),
  import: (picks: { source: string; original: string }[]) => invoke<McpServerInfo[]>("import_mcp_servers", { picks }),
};
