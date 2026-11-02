// ⌘K palette: jump to any chat or project, and run the actions that apply to
// the current selection. Rename and delete happen inline as palette pages.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CircleDot,
  Plug,
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
import { open } from "@tauri-apps/plugin-dialog";
import { focusComposer } from "@/components/chat-context";
import { ErrorText } from "@/components/error-text";
import { connectionReady } from "@/components/settings/form-state";
import { Badge } from "@/components/ui/badge";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import type { Yaah } from "@/hooks/use-yaah";
import type { SettingsTab } from "@/components/agent-setup";
import { api, canChat, PROJECT_STATUSES, type AgentProfile, type ConnectionInfo, type Project, type SessionInfo } from "@/lib/api";
import { baseName } from "@/lib/format";
import { fuzzyBest } from "@/lib/fuzzy";
import { formatKeys, SHORTCUTS, type ShortcutId } from "@/lib/shortcuts";

export type PalettePage =
  | { kind: "root" }
  | { kind: "rename"; chat: SessionInfo }
  | { kind: "delete"; chat: SessionInfo }
  | { kind: "status"; project: Project }
  | { kind: "agent" }
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
  onAddRepos: () => void;
  onLogin: (agent: AgentProfile) => void;
  onAddAgent: () => void;
  onManageAgents: () => void;
  // Settings → Integrations (GitHub, Linear, databases), optionally on one service.
  onIntegrations: (service?: string) => void;
  // Settings, optionally on one tab.
  onSettings: (tab?: SettingsTab) => void;
  onHelp: () => void;
};

// cmdk filters on `keywords`; `value` is only an id.
const filter = (_value: string, search: string, keywords?: string[]) => fuzzyBest(search, keywords ?? []);

export function CommandPalette({
  page,
  onPage,
  y,
  onNewProject,
  onAddRepos,
  onLogin,
  onAddAgent,
  onManageAgents,
  onIntegrations,
  onSettings,
  onHelp,
}: Props) {
  const [search, setSearch] = useState("");
  // Where focus goes once the dialog is gone; otherwise it returns to where it was.
  const afterClose = useRef<(() => void) | null>(null);

  // Each page starts with an empty search.
  const [searchFor, setSearchFor] = useState(page?.kind);
  if (page?.kind !== searchFor) {
    setSearchFor(page?.kind);
    setSearch("");
  }

  const close = (then?: () => void) => {
    afterClose.current = then ?? null;
    onPage(null);
  };
  /** Run an action, close, and land in the message box if there is one. */
  const run = (f: () => unknown) => {
    Promise.resolve(f()).catch(console.error);
    close(focusComposer);
  };

  const chat = y.activeChat;
  const project = y.activeProject;
  const account = y.agents.find((a) => a.id === y.agentId);
  const projectName = (id: string | null) => (id ? (y.projects.find((p) => p.id === id)?.name ?? "") : "quick chat");
  /** A quick chat in a folder the user picks (e.g. one holding the data to analyse). */
  const chatInFolder = async () => {
    const dir = await open({ directory: true, title: "Folder for the new chat" });
    if (typeof dir === "string") await y.newQuickChat(dir);
  };
  const projectChats = project ? (y.chatsByProject[project.id] ?? []) : [];

  let body: ReactNode;
  let placeholder = "Search chats, projects and actions…";
  if (page?.kind === "rename") {
    body = <RenameChat chat={page.chat} onDone={(title) => run(() => title && y.renameChat(page.chat.sessionId, title))} />;
  } else if (page?.kind === "delete") {
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
  } else if (page?.kind === "status") {
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
  } else if (page?.kind === "move") {
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
  } else if (page?.kind === "promote") {
    const folder = baseName(page.chat.cwd);
    body = (
      <TextPrompt
        label="Turn this chat into a project named"
        initial={folder.length === 12 && /^[0-9a-f]+$/.test(folder) ? page.chat.title : folder}
        hint="its folder becomes the project's first repo"
        onDone={(name) => run(() => name && y.promoteChat(page.chat.sessionId, name))}
      />
    );
  } else if (page?.kind === "connections") {
    placeholder = "Database connections…";
    body = <Connections onAdd={() => onPage({ kind: "addConnection" })} onPick={(connection) => onPage({ kind: "removeConnection", connection })} />;
  } else if (page?.kind === "addConnection") {
    body = <AddConnection onDone={() => onPage({ kind: "connections" })} />;
  } else if (page?.kind === "removeConnection") {
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
  } else if (page?.kind === "agent") {
    placeholder = "Switch agent…";
    body = (
      <CommandGroup heading="New chats use">
        {y.agents.map((a) => (
          <Item
            key={a.id}
            id={`agent-${a.id}`}
            label={a.label}
            detail={a.loggedIn === false ? "not logged in" : (a.email ?? a.presetLabel)}
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
  } else {
    const ready = canChat(account);
    body = (
      <>
        <CommandGroup heading="Actions">
          {project && ready && (
            <Item
              id="new-chat"
              icon={<MessageSquarePlus />}
              label={`New chat in ${project.name}`}
              shortcut="newChat"
              onSelect={() => run(() => y.newChat(project.id))}
            />
          )}
          {ready && (
            <Item
              id="quick-chat"
              icon={<MessageSquarePlus />}
              label="New quick chat"
              detail="no project"
              shortcut={project ? undefined : "newChat"}
              onSelect={() => run(() => y.newQuickChat())}
            />
          )}
          {ready && (
            <Item
              id="folder-chat"
              icon={<FolderOpen />}
              label="New chat in a folder…"
              onSelect={() =>
                close(() => {
                  chatInFolder().catch(console.error);
                })
              }
            />
          )}
          {chat?.running && (
            <Item
              id="stop"
              icon={<Square />}
              label="Stop the running turn"
              shortcut="stop"
              onSelect={() => run(() => api.cancelTurn(chat.sessionId))}
            />
          )}
          {chat && (
            <Item
              id="focus"
              icon={<TextCursorInput />}
              label="Focus the message box"
              shortcut="focusComposer"
              onSelect={() => close(focusComposer)}
            />
          )}
          {chat && <Item id="rename" icon={<Pencil />} label="Rename chat…" onSelect={() => onPage({ kind: "rename", chat })} />}
          {chat && (
            <Item
              id="move-chat"
              icon={<FolderInput />}
              label="Move chat to a project…"
              detail={projectName(chat.projectId)}
              onSelect={() => onPage({ kind: "move", chat })}
            />
          )}
          {chat && !chat.projectId && (
            <Item id="promote-chat" icon={<FolderPlus />} label="Turn chat into a project…" onSelect={() => onPage({ kind: "promote", chat })} />
          )}
          {chat && <Item id="delete-chat" icon={<Trash2 />} label="Delete chat…" onSelect={() => onPage({ kind: "delete", chat })} />}
          {project && <Item id="add-repos" icon={<FolderGit2 />} label={`Add repos to ${project.name}…`} onSelect={() => close(onAddRepos)} />}
          {project && (
            <Item
              id="status"
              icon={<CircleDot />}
              label="Set project status…"
              detail={project.status}
              onSelect={() => onPage({ kind: "status", project })}
            />
          )}
          <Item id="new-project" icon={<Plus />} label="New project…" shortcut="newProject" onSelect={() => close(onNewProject)} />
          {!account && <Item id="first-agent" icon={<Bot />} label="Add agent…" detail="needed to chat" onSelect={() => close(onAddAgent)} />}
          {account && (
            <Item
              id="login"
              icon={<LogIn />}
              label={`Log in “${account.label}”…`}
              detail={account.loggedIn === false ? "needed" : undefined}
              onSelect={() => close(() => onLogin(account))}
            />
          )}
          <Item id="switch-agent" icon={<Bot />} label="Switch agent…" detail={account?.label} onSelect={() => onPage({ kind: "agent" })} />
          <Item
            id="connections"
            icon={<Database />}
            label="Database connections…"
            detail="read-only, for live views"
            onSelect={() => onPage({ kind: "connections" })}
          />
          <Item id="add-connection" icon={<Database />} label="Add database connection…" onSelect={() => onPage({ kind: "addConnection" })} />
          {account && <Item id="add-agent" icon={<Plus />} label="Add agent…" detail="any ACP agent" onSelect={() => close(onAddAgent)} />}
          <Item
            id="settings"
            icon={<Settings2 />}
            label="Settings…"
            detail="general, agents, MCP, skills, integrations"
            shortcut="settings"
            onSelect={() => close(() => onSettings())}
          />
          <Item id="mcp-servers" icon={<Plug />} label="MCP servers…" onSelect={() => close(() => onSettings("mcp"))} />
          <Item id="skills" icon={<Plug />} label="Skills…" detail="install from GitHub" onSelect={() => close(() => onSettings("skills"))} />
          <Item
            id="manage-agents"
            icon={<Settings2 />}
            label="Manage agents…"
            detail="commands, logins, default"
            onSelect={() => close(onManageAgents)}
          />
          <Item
            id="integrations"
            icon={<Plug />}
            label="Integrations…"
            detail="GitHub, Linear, databases"
            onSelect={() => close(() => onIntegrations())}
          />
          <Item id="connect-linear" icon={<Plug />} label="Connect Linear…" onSelect={() => close(() => onIntegrations("linear"))} />
          <Item id="connect-github" icon={<Plug />} label="Connect GitHub…" onSelect={() => close(() => onIntegrations("github"))} />
          <Item id="help" icon={<Keyboard />} label="Keyboard shortcuts" shortcut="help" onSelect={() => close(onHelp)} />
        </CommandGroup>
        {y.chatOrder.length > 0 && (
          <CommandGroup heading="Chats">
            {y.chatOrder.map((c) => {
              const n = projectChats.indexOf(c);
              return (
                <Item
                  key={c.sessionId}
                  id={`chat-${c.sessionId}`}
                  icon={c.running ? <Loader2 className="animate-spin" /> : <MessageSquare />}
                  label={c.title}
                  detail={projectName(c.projectId)}
                  keys={n >= 0 && n < 9 ? [SHORTCUTS.jumpChat.keys[0], String(n + 1)] : undefined}
                  onSelect={() => run(() => y.setSelection({ kind: "chat", id: c.sessionId }))}
                />
              );
            })}
          </CommandGroup>
        )}
        <CommandGroup heading="Go to">
          {y.orderedProjects.map((p) => (
            <Item
              key={p.id}
              id={`project-${p.id}`}
              icon={<FolderOpen />}
              label={p.name}
              detail={p.status === "ongoing" ? undefined : p.status}
              onSelect={() => close(() => y.setSelection({ kind: "project", id: p.id }))}
            />
          ))}
          <Item
            id="components"
            icon={<LayoutPanelTop />}
            label="Component library"
            onSelect={() => close(() => y.setSelection({ kind: "components" }))}
          />
        </CommandGroup>
      </>
    );
  }

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
        {page?.kind === "rename" || page?.kind === "promote" || page?.kind === "addConnection" ? (
          body
        ) : (
          <Command filter={filter} vimBindings={false} key={page?.kind}>
            <CommandInput
              autoFocus
              value={search}
              onValueChange={setSearch}
              placeholder={placeholder}
              onKeyDown={(e) => {
                // Backspace on an empty search goes back to the top level.
                if (e.key === "Backspace" && !search && page?.kind !== "root") onPage({ kind: "root" });
              }}
            />
            <CommandList className="max-h-96">
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
              {page?.kind !== "root" && (
                <span>
                  <Kbd>⌫</Kbd> back
                </span>
              )}
              <span className="ml-auto">
                <Kbd>Esc</Kbd> close
              </span>
            </footer>
          </Command>
        )}
      </DialogContent>
    </Dialog>
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
