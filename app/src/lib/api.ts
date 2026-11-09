// Typed bindings to the Rust core. Mirrors `src-tauri/src/{agents,projects,login,session}.rs`.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Layout, Selection } from "@/lib/layout";
import type { Attachment, ImageBlock } from "@/lib/attachments";

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
  /** Lists its own sessions (ACP `session/list`), for "Resume a session…". Absent: unknown until it runs again. */
  listSessions?: boolean;
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
  /**
   * false when the agent needs a login; null when yaah can't tell yet. A profile bound to a model
   * provider whose last check passed is true; one whose check failed is false (fix the provider, not a login).
   */
  loggedIn: boolean | null;
  installed: boolean;
  /** The model provider it runs on (Settings → Model providers); absent: the agent's own sign-in. */
  provider?: ProviderBinding | null;
  /** Where it runs, shown where the email would be ("Bedrock · us-east-1 · work-sso", "OpenRouter · yaah-dev"). */
  detail?: string | null;
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
  /**
   * "installed": yaah installed its npm package and runs it with Node; "npx": not yet, so the first start goes through npx;
   * "download": yaah downloads its release archive from the ACP registry on first start (goose, OpenCode).
   */
  via: "binary" | "installed" | "npx" | "download" | "missing" | "custom";
  path: string | null;
  draft: AgentDraft;
  /** The model providers it can run on (`agent_routes.rs`); empty: only its own sign-in. */
  providers?: ProviderKind[];
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

/** Chats can start unless the agent is known to need a login (or its model provider's check failed). */
export const canChat = (agent: AgentProfile | undefined | null): agent is AgentProfile => !!agent && agent.loggedIn !== false;

/** A bound profile whose provider's last check failed: fixed in Settings → Model providers, not by logging in. */
export const needsProviderFix = (agent: AgentProfile | undefined | null): boolean => !!agent?.provider && agent.loggedIn === false;

/** What tells an agent apart in a list: its login state, where it runs, its account or its preset. */
export const agentDetail = (a: AgentProfile): string =>
  needsProviderFix(a)
    ? "fix in Settings → Model providers"
    : a.loggedIn === false
      ? "not logged in"
      : (a.detail ?? a.email ?? (a.label === a.presetLabel ? "" : a.presetLabel));

// ── Model providers (Settings → Model providers). Mirrors `src-tauri/src/providers.rs`. ──
// docs/research/model-providers-contract.md. Secrets (the OpenRouter key) live in the OS keychain and never come back.

export type ProviderKind = "openrouter" | "bedrock";
export const PROVIDER_KINDS: { kind: ProviderKind; label: string }[] = [
  { kind: "openrouter", label: "OpenRouter" },
  { kind: "bedrock", label: "Bedrock" },
];
/** Bedrock's cross-region inference-profile prefix. */
export type BedrockPrefix = "us" | "eu" | "apac" | "global";
export type BedrockConfig = { profile: string; region: string; prefix?: BedrockPrefix | null };
/** A provider's last check (`test_provider`; providers.rs `Check`). */
export type ProviderCheck = {
  ok: boolean;
  /**
   * What happened, in words: `Key "x" works · $14.20 of $20.00 left · free tier`,
   * `Signed in as <arn> (account 1234…) in us-east-1`, or why it failed.
   */
  detail: string;
  /** Who the credential is: OpenRouter's key label, the AWS account. */
  identity?: string | null;
  /** A fix yaah can run: "ssoLogin" runs `aws sso login --profile P` (`provider_sso_login`). */
  action?: "ssoLogin" | (string & {}) | null;
};
export type ProviderInfo = {
  id: string;
  kind: ProviderKind;
  label: string;
  bedrock?: BedrockConfig | null;
  /** An OpenRouter key is in the keychain. The key itself never reaches the interface. */
  hasSecret: boolean;
  /** Unix seconds of the last check. */
  checkedAt?: number | null;
  check?: ProviderCheck | null;
  /** One line, as bound profiles show it: "Bedrock · us-east-1 · work", "OpenRouter · my key". */
  summary: string;
};
export type ProviderDraft = {
  /** Absent: a new provider. */
  id?: string | null;
  kind: ProviderKind;
  label: string;
  bedrock?: BedrockConfig | null;
  /** The OpenRouter key; omitted keeps the stored one. */
  secret?: string | null;
};
export type ProviderModel = { id: string; label: string; contextLength?: number | null; tools: boolean };
export type ProviderModels = { models: ProviderModel[]; cachedAt: number };
/** A profile in ~/.aws/config or ~/.aws/credentials (names only). */
export type AwsProfile = { name: string; region?: string | null; sso: boolean };
/** An agent profile's model provider. Translated into the agent's env at spawn, never stored in its env. */
export type ProviderBinding = { providerId: string; model: string; smallModel?: string | null };
/** How a background `aws sso login` ended ("provider-sso-login"); `provider` is tested again. */
export type SsoLoginDone = { id: string; ok: boolean; provider?: ProviderInfo; error?: string };

/** The presets `agent_routes.rs` translates, for a Rust that doesn't send `AgentPreset.providers` yet. */
const ROUTED: Record<string, ProviderKind[]> = {
  goose: ["bedrock", "openrouter"],
  opencode: ["bedrock", "openrouter"],
  claude: ["bedrock", "openrouter"],
};
export const providerKindsOf = (preset: string, presets?: AgentPreset[] | null): ProviderKind[] =>
  presets?.find((p) => p.id === preset)?.providers ?? ROUTED[preset] ?? [];

/** An expired AWS SSO login, which "Sign in with AWS SSO" fixes. */
export const ssoExpired = (check: ProviderCheck | null | undefined): boolean =>
  !!check && !check.ok && (check.action === "ssoLogin" || /aws sso login/.test(check.detail));

export const providersApi = {
  list: () => invoke<ProviderInfo[]>("list_providers"),
  save: (draft: ProviderDraft) =>
    invoke<ProviderInfo>("save_provider", {
      id: draft.id ?? null,
      kind: draft.kind,
      label: draft.label,
      bedrock: draft.bedrock ?? null,
      ...(draft.secret ? { secret: draft.secret } : {}),
    }),
  /** Refused while a profile is bound to it; the message names those profiles. */
  remove: (id: string) => invoke<void>("delete_provider", { id }),
  /** Check it now; the result is kept as its `check`. */
  test: (id: string) => invoke<ProviderInfo>("test_provider", { id }),
  /**
   * `aws sso login --profile P` for a Bedrock provider: the CLI opens the browser and Rust tests
   * the provider again when it's done. Resolves with the tested provider; rejects with why it didn't finish.
   */
  ssoLogin: async (id: string): Promise<ProviderInfo> => {
    let settle: (done: SsoLoginDone) => void = () => {};
    const done = new Promise<SsoLoginDone>((resolve) => (settle = resolve));
    const unlisten = await listen<SsoLoginDone>("provider-sso-login", (e) => e.payload.id === id && settle(e.payload));
    try {
      await invoke<void>("provider_sso_login", { id });
      const result = await done;
      if (!result.provider) throw new Error(result.error ?? "The AWS SSO sign-in didn't finish.");
      return result.provider;
    } finally {
      unlisten();
    }
  },
  /** The models `preset` can use through the provider, cached for a day (`refresh` skips the cache). */
  models: (id: string, preset: string, refresh = false) => invoke<ProviderModels>("provider_models", { id, preset, refresh }),
  awsProfiles: () => invoke<AwsProfile[]>("aws_profiles"),
  /** Bind an agent profile to a provider and model, or back to the agent's own sign-in (null). */
  setProfileProvider: (accountId: string, binding: ProviderBinding | null) => invoke<AgentProfile>("set_profile_provider", { accountId, binding }),
};

/** What a new project may start with besides its name and folders. */
export type NewProjectOptions = { agentId?: string; statementOfWork?: string };

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
  /** The agent new chats in the project start with; none: the one picked in the sidebar. */
  agentId?: string;
  /** MCP servers whose tools (all of them) the project's chats run without asking. */
  trustedMcpServers?: string[];
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

/**
 * How far a new chat got (session.rs `StartStage`): the agent's process starting (only when it
 * wasn't running), then `session/new`, with the MCP servers the agent starts meanwhile.
 */
export type StartStage = "agent" | "mcpServers" | "session";

export type SessionStartingEvent = { startId: string; stage: StartStage; servers: string[] };

/**
 * The agent asked for a side pane beside its chat (`ui_open_pane`, ui_mcp.rs): a diff of one of the
 * chat's folders, or a UI entry of the chat (by index) moved out of its transcript.
 */
export type UiOpenPaneEvent = {
  sessionId: string;
  direction: "right" | "down";
  content: Extract<Selection, { kind: "diff" } | { kind: "ui" }>;
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
  /** The agent's own session id, when it differs from `sessionId` (after a switch). */
  agentSessionId?: string;
  /** Set by `switch_agent`: the agent the next message hands the chat over from. */
  handoffFrom?: string;
  /** A quick chat's own folders besides its cwd (also in `additionalDirs`); empty for project chats. */
  extraDirs: string[];
  /** Its folders changed: the next message reopens the agent's session with them first. */
  dirsChanged?: boolean;
  /** "Don't ask again" answers in this chat, by request title: the option kind chosen. Kept across restarts. */
  remembered?: Record<string, string>;
  /** A quick chat's trusted MCP servers (a project chat's are its project's). */
  trustedMcpServers?: string[];
  /** The agent's settings (model, effort, …) and the user's picks (session/config.rs). */
  config?: ChatConfig;
  /** Messages sent while a turn ran, waiting to go (session/queue.rs). Absent when empty. */
  queue?: MessageQueue;
};

/** A message waiting in a chat's queue (session/queue.rs `Queued`). */
export type QueuedMessage = {
  id: string;
  text: string;
  /** Absolute paths of the files mentioned with @. */
  mentions?: string[];
  /** What the user attached, held by the queue until it is sent or removed. */
  files?: Attachment[];
  /** How many # references the text has (read when it is sent). */
  references?: number;
  /** Unix seconds. */
  queuedAt: number;
  /** The chat's model and effort when it was queued (option id → value); the picks at send time apply. */
  config?: Record<string, string>;
  /** On its way: its references are read and its turn is starting. */
  sending?: boolean;
};

export type QueuePauseReason = "error" | "cancelled" | "permission" | "stopped" | "restart" | "sendFailed";

/** A chat's queue: Rust decides the order, when the next goes, and when it pauses. */
export type MessageQueue = {
  items?: QueuedMessage[];
  /** Why it isn't sending; absent while it sends as turns end. */
  paused?: { reason: QueuePauseReason; detail?: string };
  /** The id of the message that went last. */
  lastSent?: string;
};

/** What `send_prompt` did: started a turn, or queued the message (`position` 1 = next). */
export type Sent = { status: "started" } | { status: "queued"; id: string; position: number };

/** What Edit on a queued message hands back to the composer. */
export type EditedMessage = { text: string; mentions: string[]; attachments: Attachment[]; refused: { name: string; reason: string }[] };

/** One value of a config option. */
export type ConfigChoice = { value: string; name: string; description?: string; group?: string };

/** A session setting the agent offers (ACP session config options; session/config.rs `ConfigOption`). */
export type ConfigOption = {
  id: string;
  name: string;
  description?: string;
  /** ACP category: "model", "thought_level", "mode", … */
  category?: string;
  kind: "select" | "boolean";
  /** The value in use, one of `choices`. */
  current: string;
  choices: ConfigChoice[];
  /** "models": the older unstable `models` field. */
  source?: "models";
  /** Set by Rust on the one option the composer shows as Model and the one it shows as Effort. */
  role?: "model" | "effort";
};

export type ChatConfig = { options?: ConfigOption[]; choices?: Record<string, string> };

/** Settings → Agents, "New chats start with" (session/config.rs `AgentDefaults`). */
export type AgentConfigDefaults = {
  /** The profile's model and effort options, as its newest chat last saw them; empty before its first chat. */
  options: ConfigOption[];
  /** Option id → the value new chats start with. */
  defaults: Record<string, string>;
  /** Set when a model provider binding gives the profile its model: then there is no model default. */
  providerModel?: string;
};

export type SlashCommand = { name: string; description: string; input?: { hint?: string } | null };

/** One of an agent's own sessions, e.g. started in its CLI (session/resume.rs `AgentSession`). */
export type AgentSession = {
  /** The agent's ACP session id. */
  sessionId: string;
  title: string | null;
  /** Its working directory. */
  cwd: string;
  /** Last activity, Unix seconds. */
  updatedAt: number | null;
  /** The chat that already holds it: resuming opens that chat. */
  alreadyInYaah?: string;
};
/** A page of them; `nextCursor` fetches the next. */
export type AgentSessions = { sessions: AgentSession[]; nextCursor: string | null };

/** Profiles "Resume a session…" offers: those that list their sessions, or haven't said yet (they're asked when picked). */
export const mayListSessions = (agent: AgentProfile): boolean => agent.report?.listSessions !== false;

/** The sidebar: hidden to a strip, and its width in CSS pixels (220–480). */
export type SidebarState = { collapsed: boolean; width: number };
export const SIDEBAR = { min: 220, max: 480, default: 288 } as const;
/** `panes`: null when nothing was saved yet (one pane, the home screen). */
export type WindowLayout = { panes: Layout | null; sidebar: SidebarState };

export type Appearance = "system" | "light" | "dark";
/** The CSS variables Settings → Fonts sets on the root (index.css has their defaults). */
export const FONT_VARS = ["--font-ui", "--font-code", "--font-ui-scale", "--font-code-scale"] as const;
export type FontVar = (typeof FONT_VARS)[number];
/** What `set_fonts` takes: a family per slot (null: the system default) and sizes in px (null: the default). */
export type FontChoice = { ui: string | null; code: string | null; uiSize: number | null; codeSize: number | null };
/** The saved fonts (settings.rs `fonts_for_ui`): the choice, the size ranges, and the CSS Rust built for it (null: index.css's default). */
export type FontSettings = FontChoice & {
  limits: Record<"uiSize" | "codeSize", { min: number; max: number; default: number }>;
  css: Record<FontVar, string | null>;
};
/** A font family on this machine (fonts.rs); `mono` when a face of it is fixed-pitch. */
export type InstalledFonts = { families: { name: string; mono: boolean }[]; scanMs: number; fallback: boolean };
export type GeneralSettings = {
  appearance: Appearance;
  /** Theme ids for light and dark mode: "yaah", "shiki:<name>" or "custom:<file>". */
  theme: { light: string; dark: string };
  /** Interface and code fonts and sizes (Settings → Appearance → Fonts). */
  fonts: FontSettings;
  /** How tool cards open in chats, by kind of tool (defaults plus your own rules). */
  toolCards: { rules: Record<string, "auto" | "collapsed" | "expanded">; defaults: { key: string; mode: string }[] };
  /** VS Code themes dropped in ~/.config/yaah/themes. */
  customThemes: { file: string; label: string; type: string | null }[];
  workspaceRoots: string[];
  dataDirs: { label: string; path: string; about: string; exists: boolean }[];
  version: string;
  /** Teach agents about yaah's UI (Settings → Chat). */
  teachAgents: boolean;
  /** Allow reads and searches inside a chat's folders without asking (Settings → Chat). */
  trustReadOnly?: boolean;
  /** Draw two or more tool calls in a row as one row that opens on a click (Settings → Chat). */
  groupToolCalls?: boolean;
  /** The app "Open in terminal" uses: "system" or one of `terminalApps` (terminal_apps.rs). */
  terminalApp?: string;
  terminalApps?: { id: string; label: string }[];
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

// References to tracker items in a message (`github#owner/repo#9`, `gitlab#group/proj!45`, `linear#ENG-123`). Mirrors `src-tauri/src/references.rs`.
export type ReferenceService = "github" | "gitlab" | "linear";
export type Reference = {
  service: ReferenceService;
  kind: "pr" | "mr" | "issue";
  /** `owner/repo#9`, `group/proj!45`, `ENG-123`. */
  id: string;
  /** What goes in the text: `github#owner/repo#9`. */
  token: string;
  title: string;
  url: string;
  state: "open" | "draft" | "merged" | "closed" | "done" | "canceled" | "";
  /** The tracker's own name when it says more (Linear's "In Review", GitHub's "Not planned"). */
  status?: string;
  /** `owner/repo`, `group/proj` or a Linear team key. */
  scope: string;
  updatedAt?: string;
  /** On a sent reference that couldn't be read: why. */
  error?: string;
};
/** The composer's `#` list, ranked in Rust: the chat's repos first, then yours. `connected`: the services asked for that are. */
export type ReferenceSuggestions = {
  items: Reference[];
  connected: ReferenceService[];
  errors: { service: WorkService; kind: WorkErrorKind; message: string }[];
};

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | (string & {});
};

/** Why yaah answered a permission request itself, and the same in words ("read-only in this chat's folders"). */
export type PermissionAuto = {
  reason: "readOnly" | "trustedServer" | "trustedEverywhere" | "remembered" | "toolResults" | "webSearch" | "builtinReadOnly" | (string & {});
  why: string;
};

export type ToolContent =
  | { type: "content"; content: { type: string; text?: string } }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  /** An agent's command in a terminal yaah runs (acp_terminals.rs); once released, its last bytes (base64) and exit are kept here. */
  | { type: "terminal"; terminalId: string; keptOutput?: string; exitStatus?: { exitCode: number | null; signal: string | null } | null };

export type PlanItem = {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
};

export type Entry =
  /** `files`: what the user attached (lib/attachments.ts), as sent. `references`: tracker items the text names, as read when sent. */
  | { type: "user"; text: string; attachments: string[]; files?: Attachment[]; references?: Reference[] }
  /** `images`: image blocks in the message, their bytes in the chat's image store. */
  | { type: "agent"; text: string; messageId: string | null; images?: ImageBlock[] }
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
      /** Set on a call made inside a sub-agent: the id of the call that launched it. */
      parentToolCallId?: string;
    }
  | { type: "plan"; entries: PlanItem[] }
  | {
      type: "permission";
      requestId: unknown;
      toolCallId: string | null;
      title: string;
      options: PermissionOption[];
      chosen: string | null;
      /** The chosen option's kind, or "cancelled"; absent while waiting. */
      answer?: PermissionOption["kind"] | "cancelled";
      /** Set when yaah answered without the user clicking (session/permissions.rs). */
      auto?: PermissionAuto;
      /** The MCP server the tool belongs to, when yaah can tell: the card offers to trust it. */
      mcpServer?: { id: string; label: string };
      /** Rust's words for what the request is, above it on its card ("Claude is reading a saved tool result"). It still asks. */
      note?: string;
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
  | { type: "notices"; items: Notice[] }
  /** The chat moved to another agent (`switch_agent`); `label` is the new agent's, `from` the one before. */
  | { type: "switch"; accountId: string; label: string; from: string | null }
  /** Folders added to the chat as it went (`add_chat_dirs`): to its project, or to this chat only. */
  | { type: "addedDirs"; paths: string[]; to: "project" | "chat" }
  /** The agent asked to add folders to the chat (`ui_request_folders`) and waits for Add / Not now. */
  | { type: "folderRequest"; paths: string[]; reason: string; askId: string | null; answer: "added" | "declined" | "cancelled" | null };

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
  /** `statementOfWork` (Markdown) goes into the brief under `## Statement of work`. */
  createProject: (name: string, dirs: string[], options: NewProjectOptions = {}) =>
    invoke<Project>("create_project", { name, dirs, agentId: options.agentId || null, statementOfWork: options.statementOfWork?.trim() || null }),
  /** The agent new chats in the project start with; null: the sidebar's. */
  setProjectAgent: (id: string, agentId: string | null) => invoke<Project>("set_project_agent", { id, agentId }),
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
  /** `session`: the chat the UI is in; git sources read its folder (Rust looks it up, the page never names a path). */
  readSource: (source: unknown, session?: string) => invoke<unknown>("read_source", { source, session: session ?? null }),
  /** Open a file from a chat (relative to its folder) in the system's app for it; files that would run are refused. */
  openInEditor: (session: string, path: string) => invoke<void>("open_in_editor", { session, path }),
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
  setGroupToolCalls: (enabled: boolean) => invoke<void>("set_group_tool_calls", { enabled }),
  installedFonts: () => invoke<InstalledFonts>("installed_fonts"),
  setFonts: (fonts: FontChoice) => invoke<FontSettings>("set_fonts", { fonts }),
  /** ⌘= / ⌘- / ⌘0: sizes a step bigger (1), smaller (-1) or back to the default (0). */
  stepFontSize: (step: -1 | 0 | 1) => invoke<FontSettings>("step_font_size", { step }),
  readCustomTheme: (name: string) =>
    invoke<{ name?: string; displayName?: string; type?: string; colors: Record<string, string> }>("read_custom_theme", { name }),
  revealDataDir: (path: string) => invoke<void>("reveal_data_dir", { path }),
  /** The split panes and the sidebar as last left (layout.rs): panes on deleted chats or projects already dropped. */
  windowLayout: () => invoke<WindowLayout>("window_layout"),
  setLayout: (layout: Layout) => invoke<void>("set_layout", { layout }),
  setSidebar: (sidebar: SidebarState) => invoke<void>("set_sidebar", { collapsed: sidebar.collapsed, width: sidebar.width }),
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
  /**
   * `extraDirs`: repos chosen up front; they join the project (docs/research/chat-repos-contract.md).
   * `startId`: how far it got comes as `session-starting` events with it (`events.sessionStarting`).
   */
  newSession: (projectId: string, accountId: string, extraDirs?: string[], startId?: string) =>
    invoke<SessionInfo>("new_session", { projectId, accountId, ...(extraDirs?.length ? { extraDirs } : {}), ...(startId ? { startId } : {}) }),
  /** A chat outside any project: in `dir`, or a fresh scratch folder; `extraDirs`: repos chosen up front, the chat's own. */
  newQuickChat: (accountId: string, dir?: string, extraDirs?: string[], startId?: string) =>
    invoke<SessionInfo>("new_quick_chat", {
      accountId,
      dir: dir ?? null,
      ...(extraDirs?.length ? { extraDirs } : {}),
      ...(startId ? { startId } : {}),
    }),
  /** Add repos to a chat as it goes: to its project when it has one, else to the chat (docs/research/chat-repos-contract.md). */
  addChatDirs: (sessionId: string, paths: string[]) => invoke<SessionInfo>("add_chat_dirs", { sessionId, paths }),
  /** Answer the agent's folder request at `index`: `add` adds them as `addChatDirs` does, then the agent hears it. */
  answerFolderRequest: (sessionId: string, index: number, add: boolean) => invoke<SessionInfo>("answer_folder_request", { sessionId, index, add }),
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
  /** `attachments`: ids of what the composer attached (lib/attachments.ts `stage`). */
  /** Sends it, or queues it while a turn runs (Rust decides; session/queue.rs). */
  sendPrompt: (sessionId: string, text: string, mentions: string[] = [], attachments: string[] = []) =>
    invoke<Sent>("send_prompt", { sessionId, text, mentions, ...(attachments.length ? { attachments } : {}) }),
  /** The chat's queue (session/queue.rs): each answers with the chat's info, its queue as it is now. */
  queueRemove: (sessionId: string, id: string) => invoke<SessionInfo>("queue_remove", { sessionId, id }),
  /** Takes the message out of the queue; its attachments are staged in the composer again. */
  queueEdit: (sessionId: string, id: string) => invoke<EditedMessage>("queue_edit", { sessionId, id }),
  /** `to`: 0 = next. */
  queueMove: (sessionId: string, id: string, to: number) => invoke<SessionInfo>("queue_move", { sessionId, id, to }),
  queueClear: (sessionId: string) => invoke<SessionInfo>("queue_clear", { sessionId }),
  queueResume: (sessionId: string) => invoke<SessionInfo>("queue_resume", { sessionId }),
  /** Stops the running turn and sends this message next. */
  queueSendNow: (sessionId: string, id: string) => invoke<SessionInfo>("queue_send_now", { sessionId, id }),
  /** Unites every waiting message into one, so the next send takes them together. */
  queueMerge: (sessionId: string) => invoke<SessionInfo>("queue_merge", { sessionId }),
  /** The chat's next message goes to `accountId`'s agent, in a fresh session, with the conversation so far. Refused mid-turn. */
  switchAgent: (sessionId: string, accountId: string) => invoke<SessionInfo>("switch_agent", { sessionId, accountId }),
  /** A page of `accountId`'s own sessions (started in its CLI, say), from that profile's agent; optionally only those in `cwd`. */
  listAgentSessions: (accountId: string, cwd?: string, cursor?: string) =>
    invoke<AgentSessions>("list_agent_sessions", { accountId, cwd: cwd ?? null, cursor: cursor ?? null }),
  /** Bring one in as a chat with its history (or the chat that already holds it). */
  importAgentSession: (accountId: string, s: Pick<AgentSession, "sessionId" | "cwd" | "title">) =>
    invoke<SessionInfo>("import_agent_session", { accountId, sessionId: s.sessionId, cwd: s.cwd, title: s.title }),
  renameSession: (sessionId: string, title: string) => invoke<SessionInfo>("rename_session", { sessionId, title }),
  deleteSession: (sessionId: string) => invoke<void>("delete_session", { sessionId }),
  searchFiles: (sessionId: string, query: string, limit = 30) => invoke<FileMatch[]>("search_files", { sessionId, query, limit }),
  /** The composer's `#` list: `service` null for every connected one. Rust searches, caches (60 s) and ranks. */
  referenceSuggestions: (sessionId: string, service: ReferenceService | null, query: string) =>
    invoke<ReferenceSuggestions>("reference_suggestions", { sessionId, service, query }),
  cancelTurn: (sessionId: string) => invoke<void>("cancel_turn", { sessionId }),
  /** Change a chat's model, effort or other setting to a value its agent offered (refused mid-turn). */
  setChatConfig: (sessionId: string, configId: string, value: string) => invoke<SessionInfo>("set_chat_config", { sessionId, configId, value }),
  agentConfigDefaults: (accountId: string) => invoke<AgentConfigDefaults>("agent_config_defaults", { accountId }),
  /** `value: null` clears it. */
  setAgentConfigDefault: (accountId: string, configId: string, value: string | null) =>
    invoke<AgentConfigDefaults>("set_agent_config_default", { accountId, configId, value }),
  respondPermission: (sessionId: string, index: number, optionId: string | null) =>
    invoke<void>("respond_permission", { sessionId, index, optionId }),
  /** "Always allow tools from <server>" where the chat keeps its own (lib/trust-api.ts picks a scope). */
  trustMcpServer: (sessionId: string, index: number) => invoke<void>("trust_mcp_server", { sessionId, index }),
  untrustProjectMcpServer: (id: string, server: string) => invoke<Project>("untrust_project_mcp_server", { id, server }),
  untrustChatMcpServer: (sessionId: string, server: string) => invoke<SessionInfo>("untrust_chat_mcp_server", { sessionId, server }),
  /** Settings → Chat: allow reads and searches inside a chat's folders without asking. */
  setTrustReadOnly: (enabled: boolean) => invoke<void>("set_trust_read_only", { enabled }),
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
  /** How far a new chat started with a `startId` got. */
  sessionStarting: (cb: (e: SessionStartingEvent) => void) => on("session-starting", cb),
  /** The agent asked for a side pane beside a chat (`ui_open_pane`). */
  uiOpenPane: (cb: (e: UiOpenPaneEvent) => void) => on("ui-open-pane", cb),
  accountsChanged: (cb: () => void) => on("accounts-changed", cb),
  loginOutput: (cb: (e: { accountId: string; line: string }) => void) => on("login-output", cb),
  loginUrl: (cb: (e: { accountId: string; url: string }) => void) => on("login-url", cb),
  loginDone: (cb: (e: { accountId: string; ok: boolean; message: string | null }) => void) => on("login-done", cb),
  /** Any library installed, updated, enabled, disabled or removed. */
  librariesChanged: (cb: () => void) => on("libraries-changed", cb),
  /** A project was started from, refreshed from or unlinked from a tracker item. */
  projectsChanged: (cb: (e: { projectId: string }) => void) => on("projects-changed", cb),
  /** A model provider was added, changed, tested or removed. */
  providersChanged: (cb: () => void) => on("providers-changed", cb),
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
