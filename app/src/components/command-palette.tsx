// ⌘K palette: jump to any chat or project, and run the actions that apply to
// the current selection. Rename and delete happen inline as palette pages.
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRightLeft,
  CircleDot,
  Columns2,
  PanelLeft,
  Plug,
  Rows2,
  X,
  Database,
  FolderGit2,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Keyboard,
  LayoutPanelTop,
  Loader2,
  LogIn,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Plus,
  Settings2,
  Square,
  TextCursorInput,
  Bot,
  Trash2,
} from "lucide-react";
import { focusComposer } from "@/components/chat-context";
import { focusPaneDom } from "@/lib/pane-focus";
import { openAddRepos } from "@/lib/app-events";
import { ErrorText } from "@/components/error-text";
import { connectionReady } from "@/components/settings/form-state";
import { Badge } from "@/components/ui/badge";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import type { Yaah } from "@/hooks/use-yaah";
import type { SettingsTab } from "@/components/agent-setup";
import {
  agentDetail,
  api,
  canChat,
  needsProviderFix,
  PROJECT_STATUSES,
  type AgentProfile,
  type ConnectionInfo,
  type Project,
  type SessionInfo,
} from "@/lib/api";
import { baseName } from "@/lib/format";
import { fuzzyBest, rankTop } from "@/lib/fuzzy";
import { formatKeys, SHORTCUTS, type ShortcutId } from "@/lib/shortcuts";

export type PalettePage =
  | { kind: "root" }
  | { kind: "rename"; chat: SessionInfo }
  | { kind: "delete"; chat: SessionInfo }
  | { kind: "status"; project: Project }
  | { kind: "agent" }
  /** The agent a chat's next message goes to (`switch_agent`). */
  | { kind: "chatAgent"; sessionId: string }
  | { kind: "quickChatWith" }
  | { kind: "move"; chat: SessionInfo }
  | { kind: "promote"; chat: SessionInfo }
  | { kind: "connections" }
  | { kind: "addConnection" }
  | { kind: "removeConnection"; connection: ConnectionInfo };

type Props = {
  /** null when closed. */
  page: PalettePage | null;
  onPage: (page: PalettePage | null) => void;
  y: Yaah;
  onNewProject: () => void;
  /** The New project dialog on "From an issue". */
  onNewProjectFromItem: () => void;
  onAddRepos: () => void;
  onLogin: (agent: AgentProfile) => void;
  onAddAgent: () => void;
  onManageAgents: () => void;
  // Settings → Integrations (GitHub, Linear, GitLab, databases), optionally on one service.
  onIntegrations: (service?: string) => void;
  // Settings, optionally on one tab.
  onSettings: (tab?: SettingsTab) => void;
  onHelp: () => void;
};

// cmdk filters the small pages on `keywords`; `value` is only an id. The root page ranks itself.
const filter = (_value: string, search: string, keywords?: string[]) => fuzzyBest(search, keywords ?? []);

/** The palette. Its items are built only while it's open, so it costs nothing when closed. */
export function CommandPalette(props: Props) {
  const { page, onPage } = props;
  // Where focus goes once the dialog is gone; otherwise it returns to where it was.
  const afterClose = useRef<(() => void) | null>(null);
  // The page that was open, so the dialog keeps its content while it fades out.
  const [shown, setShown] = useState(page);
  if (page && page !== shown) setShown(page);
  const close = (then?: () => void) => {
    afterClose.current = then ?? null;
    onPage(null);
  };
  return (
    <Dialog open={page != null} onOpenChange={(o) => !o && close()}>
      <DialogContent
        className="top-1/4 translate-y-0 overflow-hidden rounded-xl! p-0 sm:max-w-lg"
        showCloseButton={false}
        onCloseAutoFocus={(e) => {
          const then = afterClose.current;
          afterClose.current = null;
          if (!then) return;
          e.preventDefault();
          then();
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Search chats, projects and actions.</DialogDescription>
        {shown && <PaletteBody {...props} page={shown} close={close} />}
      </DialogContent>
    </Dialog>
  );
}

type Entry = {
  id: string;
  icon?: ReactNode;
  label: string;
  detail?: string;
  shortcut?: ShortcutId;
  keys?: string[];
  onSelect: () => void;
};

/** Chats and projects listed at most, best first; typing finds the rest. */
const LIMIT = 50;
const rankEntries = (entries: Entry[], query: string, limit = Infinity) => rankTop(entries, query, (e) => [e.label, e.detail], limit);

function PaletteBody({
  page,
  onPage,
  close,
  y,
  onNewProject,
  onNewProjectFromItem,
  onAddRepos,
  onLogin,
  onAddAgent,
  onManageAgents,
  onIntegrations,
  onSettings,
  onHelp,
}: Props & { page: PalettePage; close: (then?: () => void) => void }) {
  const [search, setSearch] = useState("");
  // The list follows the typing a beat behind, so keystrokes never wait on it.
  const query = useDeferredValue(search);
  // The selected item on the root page, for the search it was picked in.
  const [active, setActive] = useState<{ id: string; query: string } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.scrollTo?.({ top: 0 });
  }, [query]);

  // Each page starts with an empty search.
  const [searchFor, setSearchFor] = useState(page.kind);
  if (page.kind !== searchFor) {
    setSearchFor(page.kind);
    setSearch("");
  }

  /** Run an action, close, and land in the message box if there is one. */
  const run = (f: () => unknown) => {
    Promise.resolve(f()).catch(console.error);
    close(focusComposer);
  };

  const chat = y.activeChat;
  const project = y.activeProject;
  const account = y.agents.find((a) => a.id === y.agentId);
  const projectName = (id: string | null) => (id ? (y.projects.find((p) => p.id === id)?.name ?? "") : "quick chat");
  const projectChats = project ? (y.chatsByProject[project.id] ?? []) : [];

  // The root page's lists, ranked once per (deferred) keystroke.
  const { chatOrder, orderedProjects, projects } = y;
  const chatEntries = useMemo(
    () =>
      page.kind !== "root"
        ? []
        : chatOrder.map((c): Entry & { chat: SessionInfo } => ({
            id: `chat-${c.sessionId}`,
            chat: c,
            label: c.title,
            detail: c.projectId ? (projects.find((p) => p.id === c.projectId)?.name ?? "") : "quick chat",
            onSelect: () => undefined,
          })),
    [page.kind, chatOrder, projects],
  );
  const rankedChats = useMemo(() => rankEntries(chatEntries, query, LIMIT), [chatEntries, query]);
  const projectEntries = useMemo(
    () =>
      page.kind !== "root"
        ? []
        : orderedProjects.map((p): Entry & { project: Project } => ({
            id: `project-${p.id}`,
            project: p,
            label: p.name,
            detail: p.status === "ongoing" ? undefined : p.status,
            onSelect: () => undefined,
          })),
    [page.kind, orderedProjects],
  );
  const rankedProjects = useMemo(() => rankEntries(projectEntries, query, LIMIT), [projectEntries, query]);

  let body: ReactNode;
  let placeholder = "Search chats, projects and actions…";
  /** The root page's best match, which a new search starts on. */
  let firstId = "";
  if (page.kind === "rename") {
    body = <RenameChat chat={page.chat} onDone={(title) => run(() => title && y.renameChat(page.chat.sessionId, title))} />;
  } else if (page.kind === "delete") {
    const c = y.chatOrder.find((x) => x.sessionId === page.chat.sessionId) ?? page.chat;
    placeholder = "Delete this chat?";
    body = (
      <CommandGroup heading={`Delete “${c.title}”? Its transcript is removed.`}>
        {c.running ? (
          <Item
            id="stop-first"
            icon={<Square />}
            label="It's running: stop it first"
            shortcut={chat?.sessionId === c.sessionId ? "stop" : undefined}
            onSelect={() => {
              api.cancelTurn(c.sessionId).catch(console.error);
            }}
          />
        ) : (
          <Item id="delete" icon={<Trash2 />} label="Delete chat" destructive onSelect={() => run(() => y.deleteChat(c))} />
        )}
        <Item id="keep" icon={<MessageSquare />} label="Keep it" onSelect={() => onPage({ kind: "root" })} />
      </CommandGroup>
    );
  } else if (page.kind === "status") {
    placeholder = `Set status of ${page.project.name}…`;
    body = (
      <CommandGroup heading="Status">
        {PROJECT_STATUSES.map((s) => (
          <Item
            key={s}
            id={`status-${s}`}
            label={s}
            checked={page.project.status === s}
            onSelect={() => run(async () => y.putProject(await api.setProjectStatus(page.project.id, s)))}
          />
        ))}
      </CommandGroup>
    );
  } else if (page.kind === "move") {
    placeholder = `Move “${page.chat.title}” to…`;
    body = (
      <CommandGroup heading="File this chat under">
        <Item
          id="move-none"
          icon={<MessageSquare />}
          label="No project (quick chat)"
          checked={!page.chat.projectId}
          onSelect={() => run(() => y.moveChat(page.chat.sessionId, null))}
        />
        {y.orderedProjects.map((p) => (
          <Item
            key={p.id}
            id={`move-${p.id}`}
            icon={<FolderOpen />}
            label={p.name}
            checked={page.chat.projectId === p.id}
            onSelect={() => run(() => y.moveChat(page.chat.sessionId, p.id))}
          />
        ))}
      </CommandGroup>
    );
  } else if (page.kind === "promote") {
    const folder = baseName(page.chat.cwd);
    body = (
      <TextPrompt
        label="Turn this chat into a project named"
        initial={folder.length === 12 && /^[0-9a-f]+$/.test(folder) ? page.chat.title : folder}
        hint="its folder becomes the project's first repo"
        onDone={(name) => run(() => name && y.promoteChat(page.chat.sessionId, name))}
      />
    );
  } else if (page.kind === "connections") {
    placeholder = "Database connections…";
    body = <Connections onAdd={() => onPage({ kind: "addConnection" })} onPick={(connection) => onPage({ kind: "removeConnection", connection })} />;
  } else if (page.kind === "addConnection") {
    body = <AddConnection onDone={() => onPage({ kind: "connections" })} />;
  } else if (page.kind === "removeConnection") {
    const c = page.connection;
    placeholder = `Remove “${c.name}”?`;
    body = (
      <CommandGroup heading={`Remove “${c.name}” (${c.target})? Agents can no longer read it; the database is untouched.`}>
        <Item
          id="remove"
          icon={<Trash2 />}
          label="Remove connection"
          destructive
          onSelect={() => {
            api.removeConnection(c.name).then(() => onPage({ kind: "connections" }), console.error);
          }}
        />
        <Item id="keep" icon={<Database />} label="Keep it" onSelect={() => onPage({ kind: "connections" })} />
      </CommandGroup>
    );
  } else if (page.kind === "chatAgent") {
    const c = y.chatOrder.find((x) => x.sessionId === page.sessionId);
    placeholder = "Switch this chat's agent…";
    body = c ? (
      <ChatAgentPage chat={c} agents={y.agents} onDone={() => close(focusComposer)} onLogin={(a) => close(() => onLogin(a))} />
    ) : (
      <CommandEmpty>That chat is gone.</CommandEmpty>
    );
  } else if (page.kind === "agent") {
    placeholder = "Agent for new chats…";
    body = (
      <CommandGroup heading="New chats use">
        {y.agents.map((a) => (
          <Item
            key={a.id}
            id={`agent-${a.id}`}
            label={a.label}
            detail={agentDetail(a) || a.presetLabel}
            checked={a.id === y.agentId}
            onSelect={() => {
              y.setAgentId(a.id);
              close(canChat(a) ? undefined : () => onLogin(a));
            }}
          />
        ))}
        <Item id="add-agent" icon={<Plus />} label="Add agent…" onSelect={() => close(onAddAgent)} />
      </CommandGroup>
    );
  } else if (page.kind === "quickChatWith") {
    placeholder = "New quick chat with…";
    body = (
      <CommandGroup heading="New quick chat with">
        {y.agents.map((a) => (
          <Item
            key={a.id}
            id={`quick-${a.id}`}
            icon={<Bot />}
            label={a.label}
            detail={agentDetail(a) || a.presetLabel}
            shortcut={a.id === y.agentId && !project ? "newChat" : undefined}
            onSelect={() => (canChat(a) ? run(() => y.newQuickChat(undefined, a.id)) : close(() => onLogin(a)))}
          />
        ))}
      </CommandGroup>
    );
  } else {
    const ready = canChat(account);
    const manyPanes = y.panes.panes.length > 1;
    // A project's chats start with its own agent.
    const projectAgent = project ? y.agents.find((a) => a.id === y.agentFor(project.id)) : undefined;
    const actions: (Entry | false | null | undefined)[] = [
      project &&
        canChat(projectAgent) && {
          id: "new-chat",
          icon: <MessageSquarePlus />,
          label: `New chat in ${project.name}`,
          detail: projectAgent.label,
          shortcut: "newChat",
          onSelect: () => run(() => y.newChat(project.id)),
        },
      ready && {
        id: "quick-chat",
        icon: <MessageSquarePlus />,
        label: "New quick chat",
        detail: "no project",
        shortcut: project ? undefined : "newChat",
        onSelect: () => run(() => y.newQuickChat()),
      },
      y.agents.length > 1 && {
        id: "quick-chat-with",
        icon: <Bot />,
        label: "New quick chat with…",
        detail: "pick the agent",
        onSelect: () => onPage({ kind: "quickChatWith" }),
      },
      ready && {
        id: "folder-chat",
        icon: <FolderOpen />,
        label: "New chat in a folder…",
        onSelect: () =>
          close(() => {
            y.newChatInFolder().catch(console.error);
          }),
      },
      chat?.running && {
        id: "stop",
        icon: <Square />,
        label: "Stop the running turn",
        shortcut: "stop",
        onSelect: () => run(() => api.cancelTurn(chat.sessionId)),
      },
      chat && {
        id: "focus",
        icon: <TextCursorInput />,
        label: "Focus the message box",
        shortcut: "focusComposer",
        onSelect: () => close(focusComposer),
      },
      chat && {
        id: "add-chat-repos",
        icon: <FolderGit2 />,
        label: "Add repositories…",
        detail: chat.projectId ? `to ${projectName(chat.projectId)}` : "to this chat",
        onSelect: () => close(() => openAddRepos(chat.sessionId, y.panes.focusedId())),
      },
      chat && { id: "rename", icon: <Pencil />, label: "Rename chat…", onSelect: () => onPage({ kind: "rename", chat }) },
      chat && {
        id: "move-chat",
        icon: <FolderInput />,
        label: "Move chat to a project…",
        detail: projectName(chat.projectId),
        onSelect: () => onPage({ kind: "move", chat }),
      },
      chat &&
        !chat.projectId && {
          id: "promote-chat",
          icon: <FolderPlus />,
          label: "Turn chat into a project…",
          onSelect: () => onPage({ kind: "promote", chat }),
        },
      chat && { id: "delete-chat", icon: <Trash2 />, label: "Delete chat…", onSelect: () => onPage({ kind: "delete", chat }) },
      // With a chat open, its own "Add repositories…" (above) adds to its project and tells the chat.
      project && !chat && { id: "add-repos", icon: <FolderGit2 />, label: `Add repos to ${project.name}…`, onSelect: () => close(onAddRepos) },
      project && {
        id: "status",
        icon: <CircleDot />,
        label: "Set project status…",
        detail: project.status,
        onSelect: () => onPage({ kind: "status", project }),
      },
      // Split panes: the keyboard lands in the pane that opens or takes over.
      {
        id: "split-right",
        icon: <Columns2 />,
        label: "Split right",
        detail: "a new pane beside this one",
        shortcut: "splitRight",
        onSelect: () => close(() => focusPaneDom(y.panes.split("row"))),
      },
      {
        id: "split-down",
        icon: <Rows2 />,
        label: "Split down",
        detail: "a new pane below this one",
        shortcut: "splitDown",
        onSelect: () => close(() => focusPaneDom(y.panes.split("column"))),
      },
      manyPanes && {
        id: "close-pane",
        icon: <X />,
        label: "Close pane",
        shortcut: "closePane",
        onSelect: () =>
          close(() => {
            y.panes.close();
            focusPaneDom(y.panes.focusedId());
          }),
      },
      manyPanes && { id: "next-pane", icon: <ArrowRightLeft />, label: "Focus next pane", onSelect: () => close(() => focusPaneDom(y.panes.next())) },
      {
        id: "toggle-sidebar",
        icon: <PanelLeft />,
        label: y.panes.sidebar.collapsed ? "Show sidebar" : "Hide sidebar",
        shortcut: "toggleSidebar",
        onSelect: () => run(() => y.panes.toggleSidebar()),
      },
      { id: "new-project", icon: <Plus />, label: "New project…", shortcut: "newProject", onSelect: () => close(onNewProject) },
      {
        id: "new-project-from-item",
        icon: <CircleDot />,
        label: "New project from an issue…",
        detail: "GitHub, Linear, GitLab",
        onSelect: () => close(onNewProjectFromItem),
      },
      !account && { id: "first-agent", icon: <Bot />, label: "Add agent…", detail: "needed to chat", onSelect: () => close(onAddAgent) },
      // A profile on a model provider has no login of its own: its provider is fixed in Settings.
      account &&
        !account.provider && {
          id: "login",
          icon: <LogIn />,
          label: `Log in “${account.label}”…`,
          detail: account.loggedIn === false ? "needed" : undefined,
          onSelect: () => close(() => onLogin(account)),
        },
      needsProviderFix(account) &&
        account && {
          id: "fix-provider",
          icon: <LogIn />,
          label: `Fix “${account.label}” in Settings → Model providers…`,
          detail: "its provider's check failed",
          onSelect: () => close(() => onLogin(account)),
        },
      chat &&
        y.agents.length > 1 && {
          id: "switch-chat-agent",
          icon: <Bot />,
          label: "Switch agent…",
          detail: `this chat: ${y.agents.find((a) => a.id === chat.accountId)?.label ?? chat.accountId}`,
          onSelect: () => onPage({ kind: "chatAgent", sessionId: chat.sessionId }),
        },
      { id: "default-agent", icon: <Bot />, label: "Agent for new chats…", detail: account?.label, onSelect: () => onPage({ kind: "agent" }) },
      {
        id: "connections",
        icon: <Database />,
        label: "Database connections…",
        detail: "read-only, for live views",
        onSelect: () => onPage({ kind: "connections" }),
      },
      { id: "add-connection", icon: <Database />, label: "Add database connection…", onSelect: () => onPage({ kind: "addConnection" }) },
      account && { id: "add-agent", icon: <Plus />, label: "Add agent…", detail: "any ACP agent", onSelect: () => close(onAddAgent) },
      {
        id: "settings",
        icon: <Settings2 />,
        label: "Settings…",
        detail: "general, agents, MCP, skills, components, integrations",
        shortcut: "settings",
        onSelect: () => close(() => onSettings()),
      },
      { id: "mcp-servers", icon: <Plug />, label: "MCP servers…", onSelect: () => close(() => onSettings("mcp")) },
      { id: "skills", icon: <Plug />, label: "Skills…", detail: "install from GitHub", onSelect: () => close(() => onSettings("skills")) },
      {
        id: "install-library",
        icon: <LayoutPanelTop />,
        label: "Install component library…",
        detail: "from a git repo or a folder",
        onSelect: () => close(() => onSettings("components")),
      },
      {
        id: "manage-agents",
        icon: <Settings2 />,
        label: "Manage agents…",
        detail: "commands, logins, default",
        onSelect: () => close(onManageAgents),
      },
      {
        id: "integrations",
        icon: <Plug />,
        label: "Integrations…",
        detail: "GitHub, Linear, GitLab, databases",
        onSelect: () => close(() => onIntegrations()),
      },
      { id: "connect-linear", icon: <Plug />, label: "Connect Linear…", onSelect: () => close(() => onIntegrations("linear")) },
      { id: "connect-github", icon: <Plug />, label: "Connect GitHub…", onSelect: () => close(() => onIntegrations("github")) },
      { id: "connect-gitlab", icon: <Plug />, label: "Connect GitLab…", onSelect: () => close(() => onIntegrations("gitlab")) },
      { id: "help", icon: <Keyboard />, label: "Keyboard shortcuts", shortcut: "help", onSelect: () => close(onHelp) },
    ];
    const rankedActions = rankEntries(
      actions.filter((a): a is Entry => !!a),
      query,
    );
    const goTo: Entry = {
      id: "components",
      icon: <LayoutPanelTop />,
      label: "Component library",
      onSelect: () => close(() => y.setSelection({ kind: "components" })),
    };
    const goToShown = rankEntries([goTo], query);
    // While searching, the group with the best match comes first.
    const groups = [
      {
        id: "actions",
        best: rankedActions.best,
        node: rankedActions.shown.length > 0 && (
          <CommandGroup key="actions" heading="Actions">
            {rankedActions.shown.map((a) => (
              <Item key={a.id} {...a} />
            ))}
          </CommandGroup>
        ),
      },
      {
        id: "chats",
        best: rankedChats.best,
        node: rankedChats.shown.length > 0 && (
          <CommandGroup key="chats" heading="Chats">
            {rankedChats.shown.map((e) => {
              const c = (e as Entry & { chat: SessionInfo }).chat;
              const n = projectChats.indexOf(c);
              return (
                <Item
                  key={e.id}
                  id={e.id}
                  icon={c.running ? <Loader2 className="animate-spin" /> : <MessageSquare />}
                  label={e.label}
                  detail={e.detail}
                  keys={n >= 0 && n < 9 ? [SHORTCUTS.jumpChat.keys[0], String(n + 1)] : undefined}
                  onSelect={() => run(() => y.setSelection({ kind: "chat", id: c.sessionId }))}
                />
              );
            })}
            {rankedChats.more > 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{rankedChats.more} more: type to find them.</p>}
          </CommandGroup>
        ),
      },
      {
        id: "goto",
        best: Math.max(rankedProjects.best, goToShown.best),
        node: (rankedProjects.shown.length > 0 || goToShown.shown.length > 0) && (
          <CommandGroup key="goto" heading="Go to">
            {rankedProjects.shown.map((e) => {
              const p = (e as Entry & { project: Project }).project;
              return (
                <Item
                  key={e.id}
                  id={e.id}
                  icon={<FolderOpen />}
                  label={e.label}
                  detail={e.detail}
                  onSelect={() => close(() => y.setSelection({ kind: "project", id: p.id }))}
                />
              );
            })}
            {goToShown.shown.map((e) => (
              <Item key={e.id} {...e} />
            ))}
          </CommandGroup>
        ),
      },
    ];
    if (query.trim()) groups.sort((a, b) => b.best - a.best);
    body = groups.map((g) => g.node);
    const shownGroups: Record<string, Entry[]> = {
      actions: rankedActions.shown,
      chats: rankedChats.shown,
      goto: [...rankedProjects.shown, ...goToShown.shown],
    };
    firstId = groups.map((g) => shownGroups[g.id][0]?.id).find(Boolean) ?? "";
  }

  if (page.kind === "rename" || page.kind === "promote" || page.kind === "addConnection") return body;
  const root = page.kind === "root";
  // cmdk doesn't filter the root page, so it doesn't move the selection either: each search starts on its best match, at the top.
  const pick = root ? { value: active?.query === query ? active.id : firstId, onValueChange: (id: string) => setActive({ id, query }) } : {};
  return (
    // The root page is ranked above (once per keystroke, top results only); the small pages let cmdk filter.
    <Command filter={filter} shouldFilter={!root} vimBindings={false} key={page.kind} {...pick}>
      <CommandInput
        autoFocus
        value={search}
        onValueChange={setSearch}
        placeholder={placeholder}
        onKeyDown={(e) => {
          // Backspace on an empty search goes back to the top level.
          if (e.key === "Backspace" && !search && !root) onPage({ kind: "root" });
        }}
      />
      <CommandList className="max-h-96" ref={list}>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        {body}
      </CommandList>
      <footer className="flex items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
        </span>
        <span>
          <Kbd>↵</Kbd> run
        </span>
        {!root && (
          <span>
            <Kbd>⌫</Kbd> back
          </span>
        )}
        <span className="ml-auto">
          <Kbd>Esc</Kbd> close
        </span>
      </footer>
    </Command>
  );
}

function Item({
  id,
  icon,
  label,
  detail,
  shortcut,
  keys,
  checked,
  destructive,
  onSelect,
}: {
  id: string;
  icon?: ReactNode;
  label: string;
  detail?: string;
  shortcut?: ShortcutId;
  keys?: string[];
  checked?: boolean;
  destructive?: boolean;
  onSelect: () => void;
}) {
  const shown = shortcut ? SHORTCUTS[shortcut].keys : keys;
  return (
    <CommandItem
      value={id}
      keywords={[label, detail ?? ""]}
      onSelect={onSelect}
      data-checked={checked}
      className={destructive ? "text-destructive data-selected:text-destructive *:[svg]:text-destructive!" : undefined}
    >
      {icon}
      <span className="truncate">{label}</span>
      {detail && (
        <Badge variant="outline" className="max-w-40 truncate font-normal text-muted-foreground">
          {detail}
        </Badge>
      )}
      {shown && <CommandShortcut>{formatKeys(shown)}</CommandShortcut>}
    </CommandItem>
  );
}

function RenameChat({ chat, onDone }: { chat: SessionInfo; onDone: (title: string) => void }) {
  return <TextPrompt label="Rename chat" initial={chat.title} onDone={(title) => onDone(title === chat.title ? "" : title)} />;
}

/** One-line input inside the palette: Enter submits the trimmed text, Esc cancels. */
function TextPrompt({ label, initial, hint, onDone }: { label: string; initial: string; hint?: string; onDone: (text: string) => void }) {
  const [text, setText] = useState(initial);
  return (
    <div className="flex flex-col gap-2 p-3">
      <label htmlFor="palette-prompt" className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        id="palette-prompt"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          onDone(text.trim());
        }}
      />
      <p className="text-xs text-muted-foreground">
        {hint && <>{hint} · </>}
        <Kbd>↵</Kbd> save · <Kbd>Esc</Kbd> cancel
      </p>
    </div>
  );
}

/** Saved database connections. Picking one offers to remove it. */
function Connections({ onAdd, onPick }: { onAdd: () => void; onPick: (c: ConnectionInfo) => void }) {
  const [list, setList] = useState<ConnectionInfo[] | null>(null);
  useEffect(() => {
    api.listConnections().then(setList, console.error);
  }, []);
  return (
    <CommandGroup heading="Agents see these names only; credentials stay in yaah. Queries run read-only.">
      {list?.map((c) => (
        <Item key={c.name} id={`conn-${c.name}`} icon={<Database />} label={c.name} detail={c.target} onSelect={() => onPick(c)} />
      ))}
      <Item id="add-connection" icon={<Plus />} label="Add database connection…" onSelect={onAdd} />
    </CommandGroup>
  );
}

/** Name + URL, tested with a query before it's saved. */
function AddConnection({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = connectionReady(name, url);
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.addConnection(name, url.trim());
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void save();
  };
  return (
    <div className="flex flex-col gap-2 p-3">
      <span className="text-xs font-medium text-muted-foreground">Add a Postgres connection</span>
      <label htmlFor="conn-name" className="sr-only">
        Name
      </label>
      <Input
        id="conn-name"
        autoFocus
        placeholder="name agents use, e.g. shop"
        value={name}
        onChange={(e) => setName(e.target.value.toLowerCase())}
        onKeyDown={submit}
      />
      <label htmlFor="conn-url" className="sr-only">
        URL
      </label>
      <Input
        id="conn-url"
        type="password"
        placeholder="postgres://user:password@host:5432/db"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={submit}
      />
      <ErrorText error={error} />
      <p className="text-xs text-muted-foreground">
        {busy ? "Testing the connection…" : "Tested before saving · stored only on this machine · queries run read-only"} · <Kbd>↵</Kbd> save ·{" "}
        <Kbd>Esc</Kbd> cancel
      </p>
    </div>
  );
}

/**
 * Who answers a chat's next message. The chat stays as it is; the agent picked gets a
 * fresh session with the conversation so far (session.rs `switch_agent`). Refused mid-turn.
 */
function ChatAgentPage({
  chat,
  agents,
  onDone,
  onLogin,
}: {
  chat: SessionInfo;
  agents: AgentProfile[];
  onDone: () => void;
  onLogin: (agent: AgentProfile) => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pick = (a: AgentProfile) => {
    if (a.id === chat.accountId) return onDone();
    if (!canChat(a)) return onLogin(a);
    setBusy(a.id);
    setError(null);
    api
      .switchAgent(chat.sessionId, a.id)
      .then(onDone, setError)
      .finally(() => setBusy(null));
  };
  return (
    <>
      <CommandGroup heading={chat.running ? "The next message goes to… (once this turn ends)" : "The next message goes to"}>
        {agents.map((a) => (
          <Item
            key={a.id}
            id={`chat-agent-${a.id}`}
            icon={busy === a.id ? <Loader2 className="animate-spin" /> : <Bot />}
            label={a.label}
            detail={a.id === chat.accountId ? "this chat's agent" : agentDetail(a) || a.presetLabel}
            checked={a.id === chat.accountId}
            onSelect={() => pick(a)}
          />
        ))}
      </CommandGroup>
      <p className="px-3 pt-1 pb-2 text-xs text-muted-foreground">The chat continues; the new agent gets the conversation so far.</p>
      <ErrorText error={error} className="px-3 pb-2" />
    </>
  );
}
