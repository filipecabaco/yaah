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
  /** Takes a client system prompt (ACP `systemPrompt`); yaah's UI guide goes there. */
  systemPrompt?: boolean;
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

/** What yaah knows about one version of an npm-based agent (`agent_versions.rs`). */
export type AgentVersionStatus = "installed" | "verifying" | "verified" | "failed";
export type AgentAdvisory = { id: string; severity: string; title: string; url: string };
/** One run of the adapter conformance suite on a version (`agent_conformance.rs`). */
export type ConformanceCheck = { name: string; ok: boolean; detail: string };
export type ConformanceReport = {
  version: string;
  /** Empty when the report only holds a daily audit. */
  checks: ConformanceCheck[];
  advisories: AgentAdvisory[];
  /** How the last `npm audit` went: "unavailable" (offline) and "error" keep the last answer. */
  audit: "none" | "ok" | "unavailable" | "error";
  auditDetail?: string;
  auditedAt?: number;
  checkedAt: number;
  seconds: number;
  promoted: boolean;
};

export type AgentPreset = {
  id: string;
  label: string;
  blurb: string;
  docs: string;
  install: string;
  /** "installed": yaah installed its npm package and runs it with Node; "npx": not yet, so the first start goes through npx. */
  via: "binary" | "installed" | "npx" | "missing" | "custom";
  path: string | null;
  draft: AgentDraft;
  // npm-based presets only (null/false/[] otherwise).
  package: string | null;
  /** The version yaah was tested with. */
  pinned: string | null;
  /** The version that runs: the hold, else the newest verified one, else the pin. */
  active: string | null;
  /** "tested" for the pin, else the active version's status. */
  activeStatus: "tested" | AgentVersionStatus | null;
  advisories: AgentAdvisory[];
  /** The conformance suite's last report on the active version (or only its daily audit). */
  report: ConformanceReport | null;
  /** The user holds the agent at the active version. */
  held: boolean;
  /** yaah's copy of the active version is installed. */
  installed: boolean;
  latest: { latest: string; checkedAt: number } | null;
  /** The newest version above the active one that yaah has installed or checked. */
  candidate: {
    version: string;
    status: AgentVersionStatus;
    checkedAt: number;
    failures: string[];
    advisories: AgentAdvisory[];
    report: ConformanceReport | null;
  } | null;
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
  /** The tracker item the project was started from (read-only). */
  link?: ProjectLink;
};

// Projects from tracker items. Mirrors `src-tauri/src/work_items.rs`.
export type WorkService = "github" | "linear" | "linear-project" | "gitlab";
export type WorkItem = {
  service: WorkService;
  /** `owner/repo#12`, `ENG-142`, a Linear project's slug id, `group/proj#7`. */
  id: string;
  title: string;
  url: string;
  status?: string;
  assignee?: string;
  labels: string[];
  relation?: "assigned" | "created" | "lead" | "member";
  /** `owner/repo` or `group/proj`, for GitHub and GitLab. */
  repo?: string;
  /** The yaah project already linked to it, if any. */
  projectId?: string;
  updatedAt?: string;
};
export type WorkErrorKind = "auth" | "forbidden" | "not_found" | "rate_limited" | "other";
/** The user's open items from every connected service; one failing never hides the others. */
export type WorkQueue = { items: WorkItem[]; errors: { service: WorkService; kind: WorkErrorKind; message: string }[] };
/** The tracker item a project follows. Times are Unix seconds. */
export type ProjectLink = { service: WorkService; id: string; url: string; title: string; linkedAt: number; syncedAt: number };
export type StartedProject = {
  project: Project;
  /** A project already followed this item; nothing was created. */
  existing: boolean;
  chatId?: string;
  /** The composer's text for the new chat. Never sent. */
  draft?: string;
  /** Local clones added to the project's folders. */
  addedRepos: string[];
  /** Why no chat was opened (the project was still created). */
  chatError?: string;
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
  /** Teach agents about yaah's UI (Settings → Chat). */
  teachAgents: boolean;
};

/** How an agent hears about yaah's UI (`agent_guide.rs` `Route`). */
export type GuideRoute = "mcp" | "acpSystemPrompt" | "firstPrompt" | "claudeSystemPrompt" | "claudePlugin";

/** What agents are told about yaah's UI, and how it reaches each configured agent. */
export type AgentGuide = {
  enabled: boolean;
  /** The short guide, with the component index filled in. */
  guide: string;
  skillsDir: string;
  pluginDir: string;
  skills: { name: string; description: string; path: string; text: string }[];
  /** `known` is false until the agent has started once. */
  agents: { id: string; label: string; known: boolean; routes: { id: GuideRoute; label: string }[] }[];
};

/** A service yaah reads for the user (GitHub, Linear), as Settings shows it. */
export type IntegrationStatus = {
  id: string;
  label: string;
  about: string;
  /** "key": no OAuth app is configured, so a personal key is the only way. */
  flow: "device" | "browser" | "key";
  connected: boolean;
  /** oauth, key or env (a token in the environment). */
  via: "" | "oauth" | "key" | "env";
  account: string | null;
  needsReauth: boolean;
  /**
   * What Settings shows. "refused": the service refused the stored credential on a real call
   * (HTTP 401, a token without the scope), so it isn't working whatever `connected` says, until
   * a call works again or the user reconnects. "needsReauth": the sign-in expired.
   */
  state?: IntegrationState;
  /** Why, for "refused" and "needsReauth". Never a token. */
  message?: string | null;
  keyEnv: string;
  keyUrl: string;
  /** GitLab only: the instance it's on (`https://gitlab.com` unless self-managed). */
  baseUrl?: string;
};
export type IntegrationState = "connected" | "refused" | "needsReauth" | "disconnected";
/** The integration's state; from the older fields when Rust doesn't send one. */
export const integrationState = (s: IntegrationStatus): IntegrationState =>
  s.state ?? (s.needsReauth ? "needsReauth" : s.connected ? "connected" : "disconnected");
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

/** A page of a transcript (`get_entries`). */
export type EntryPage = { entries: Entry[]; from: number; total: number };

/** A new entry at `index`, or one replaced in place. */
export type SessionEntryEvent = { sessionId: string; index: number; entry: Entry };
/**
 * `text` appended to the `field` ("text") of the agent message or thought at `index`.
 * `len` is that field's length afterwards, in UTF-16 code units (JS string length):
 * it is applied only when the shown text is `len - text.length` long; otherwise the
 * entry is fetched again (docs/research/streaming-contract.md).
 */
export type SessionAppendEvent = { sessionId: string; index: number; field: "text" | (string & {}); text: string; len: number };
/** Only the draft of the form at `index` changed; the rest of the UI entry is as shown. */
export type SessionDraftEvent = {
  sessionId: string;
  index: number;
  draft: Record<string, unknown>;
  draftBy?: Record<string, "user" | "agent">;
};

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
  /** The title of the component library it comes from, for components of an installed library (`source` is its id). */
  library?: string;
};

// Component libraries (Settings → Components): installed sets of components, beside yaah's own and the user's (see ui_library.rs).
/** Where an installed library comes from. */
export type LibrarySource = { kind: "git"; url: string; ref?: string } | { kind: "folder"; path: string };
export type LibraryComponent = {
  /** Qualified, e.g. `acme/pr-card`. */
  name: string;
  description: string;
  /** Invalid components are reported and not loaded. */
  valid: boolean;
  error?: string;
};
export type LibraryInfo = {
  /** "yaah" (bundled), "local" (the user's own), or the manifest name. */
  id: string;
  kind: "builtin" | "local" | "git" | "folder";
  title: string;
  description: string;
  publisher?: string;
  homepage?: string;
  version?: string;
  /** git and folder libraries only. */
  source?: LibrarySource;
  /** git only: the checked-out commit (full sha). */
  commit?: string;
  /** builtin and local are always enabled. */
  enabled: boolean;
  components: LibraryComponent[];
  /** Source kinds its live views read (`github`, `postgres`…), sorted. */
  reads: string[];
  /** Other libraries its components reference. */
  needs: string[];
  /** Library-level problems (a missing manifest field, a skipped symlink…). */
  errors: string[];
  installedAt?: number;
  updatedAt?: number;
};
/** A library fetched into staging and validated; nothing is installed yet. */
export type LibraryPreview = LibraryInfo & {
  stagingId: string;
  /** The id of an installed library that installing this one replaces. */
  replaces?: string;
};
export type LibraryUpdate = { library: LibraryInfo; from?: string; to?: string; changed: string[] };
/** `yaah-library.json`. */
export type LibraryManifest = { name: string; title: string; description: string; publisher?: string; homepage?: string; version: string };
/** `missing`: local components the picked ones use but weren't picked; nothing was written. */
export type LibraryExport = { path: string; missing: string[] };

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
  /** Hold an npm-based agent at `version`, or release the hold (null). `running`: profiles still on the old version. */
  holdAgentVersion: (preset: string, version: string | null) =>
    invoke<{ presets: AgentPreset[]; running: string[] }>("hold_agent_version", { preset, version }),
  /** Read the latest versions now; newer ones are installed and checked before they run. */
  checkAgentUpdates: () => invoke<AgentPreset[]>("check_agent_updates"),
  /** "Verify now": run the conformance suite (tier A and npm audit) on a version; a passing candidate is promoted. */
  verifyAgentVersion: (preset: string, version: string) =>
    invoke<{ report: ConformanceReport; presets: AgentPreset[] }>("verify_agent_version", { preset, version }),
  /** Stop these profiles' agents so the next chat starts the version that should run. */
  restartAgents: (ids: string[]) => invoke<void>("restart_agents", { ids }),
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

  // projects from tracker items (read-only toward every tracker)
  workQueue: () => invoke<WorkQueue>("work_queue"),
  /** A pasted URL or id (`owner/repo#12`, `ENG-142`, a Linear project URL…). */
  resolveWorkItem: (input: string) => invoke<WorkItem>("resolve_work_item", { input }),
  /** Creates the project (or returns the one already following the item) and opens a chat with the prompt drafted, never sent. */
  startProjectFromItem: (service: WorkService, id: string, accountId?: string) =>
    invoke<StartedProject>("start_project_from_item", { service, id, accountId: accountId || null }),
  /** Re-fetch the item and rewrite the brief's block; never the status or name. */
  refreshProjectLink: (projectId: string) => invoke<Project>("refresh_project_link", { projectId }),
  /** Drop the link and the brief's block. */
  unlinkProject: (projectId: string) => invoke<Project>("unlink_project", { projectId }),
  readBrief: (id: string) => invoke<string>("read_brief", { id }),
  writeBrief: (id: string, text: string) => invoke<void>("write_brief", { id, text }),

  // sources (data the app reads itself) and database connections
  readSource: (source: unknown) => invoke<unknown>("read_source", { source }),
  // integrations (Settings → Integrations): never returns a token
  integrationsStatus: () => invoke<IntegrationStatus[]>("integrations_status"),
  /** `baseUrl`: GitLab's instance for a self-managed one; omitted means gitlab.com. */
  integrationConnect: (service: string, baseUrl?: string) => invoke<IntegrationStart>("integration_connect", { service, baseUrl: baseUrl || null }),
  integrationSetKey: (service: string, key: string, baseUrl?: string) =>
    invoke<{ account: string }>("integration_set_key", { service, key, baseUrl: baseUrl || null }),
  integrationDisconnect: (service: string) => invoke<void>("integration_disconnect", { service }),
  // Settings → General
  generalSettings: () => invoke<GeneralSettings>("general_settings"),
  setAppearance: (appearance: Appearance) => invoke<void>("set_appearance", { appearance }),
  setTheme: (light: string, dark: string) => invoke<void>("set_theme", { light, dark }),
  setToolCard: (key: string, mode: string | null) => invoke<void>("set_tool_card", { key, mode }),
  agentGuide: () => invoke<AgentGuide>("agent_guide"),
  setTeachAgents: (enabled: boolean) => invoke<void>("set_teach_agents", { enabled }),
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
  /**
   * A page of a transcript: `entries` are the ones at `from`, `from + 1`… of `total`.
   * Without `from` and `limit`, the last 200 (see docs/research/streaming-contract.md).
   */
  getEntries: (sessionId: string, from?: number, limit?: number) =>
    invoke<EntryPage>("get_entries", { sessionId, from: from ?? null, limit: limit ?? null }),
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

/** Component libraries: install, update, share. Rust fetches, validates and stores; errors are strings for the user. */
export const libraryApi = {
  /** yaah's own first, then the user's, then installed ones by title. */
  list: () => invoke<LibraryInfo[]>("list_libraries"),
  /** Fetch into a staging folder and validate. Installs nothing. */
  inspect: (source: LibrarySource) => invoke<LibraryPreview>("inspect_library", { source }),
  install: (stagingId: string) => invoke<LibraryInfo>("install_library", { stagingId }),
  /** git: fetch and reset to its ref; folder: read it again. */
  update: (id: string) => invoke<LibraryUpdate>("update_library", { id }),
  setEnabled: (id: string, enabled: boolean) => invoke<LibraryInfo>("set_library_enabled", { id, enabled }),
  remove: (id: string) => invoke<void>("remove_library", { id }),
  /** Copy a yaah or library component (qualified name) into the user's collection. */
  copyComponent: (name: string, newName?: string) => invoke<UiComponent>("copy_component", { name, newName: newName ?? null }),
  /** Write `<dir>/<manifest.name>/` from local components, ready to publish as a git repo. */
  exportLibrary: (dir: string, manifest: LibraryManifest, components: string[]) =>
    invoke<LibraryExport>("export_library", { dir, manifest, components }),
};

export const events = {
  sessionEntry: (cb: (e: SessionEntryEvent) => void) => on("session-entry", cb),
  /** Text appended to an agent message or a thought (see `SessionAppendEvent`). */
  sessionAppend: (cb: (e: SessionAppendEvent) => void) => on("session-append", cb),
  /** A form's shared draft changed (the user's edit or the agent's `ui_set_values`). */
  sessionDraft: (cb: (e: SessionDraftEvent) => void) => on("session-draft", cb),
  sessionInfo: (cb: (info: SessionInfo) => void) => on("session-info", cb),
  accountsChanged: (cb: () => void) => on("accounts-changed", cb),
  loginOutput: (cb: (e: { accountId: string; line: string }) => void) => on("login-output", cb),
  loginUrl: (cb: (e: { accountId: string; url: string }) => void) => on("login-url", cb),
  loginDone: (cb: (e: { accountId: string; ok: boolean; message: string | null }) => void) => on("login-done", cb),
  /** Any library installed, updated, enabled, disabled or removed. */
  librariesChanged: (cb: () => void) => on("libraries-changed", cb),
  /** A project was started from, refreshed from or unlinked from a tracker item. */
  projectsChanged: (cb: (e: { projectId: string }) => void) => on("projects-changed", cb),
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
  /**
   * Env vars and headers whose value Rust sent masked (`••••`, or `••••1234` for a long one):
   * the real value never reaches the interface. Sending the masked value back unchanged keeps it.
   */
  secretEnv?: string[];
  secretHeaders?: string[];
};
/** How a masked secret starts (mcp_servers.rs `MASK`). */
export const SECRET_MASK = "••••";
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
