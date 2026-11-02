import { useState, type ReactElement } from "react";
import {
  ChevronRight,
  CircleDot,
  Copy,
  FolderGit2,
  FolderOpen,
  LayoutPanelTop,
  Loader2,
  LogIn,
  MessageSquare,
  MessageSquarePlus,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
  Settings,
} from "lucide-react";
import { ChatMenu, CopyMenuItem } from "@/components/menus";
import { RepoPicker } from "@/components/repo-picker";
import { Hint } from "@/components/shortcuts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { api, canChat, PROJECT_STATUSES, type AgentProfile, type Project, type ProjectStatus, type SessionInfo } from "@/lib/api";
import { baseName, compactPath } from "@/lib/format";
import { ErrorText } from "@/components/error-text";
import type { Selection } from "@/hooks/use-yaah";
import { formatKeys, SHORTCUTS } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

type Props = {
  agents: AgentProfile[];
  agentId: string;
  onAgent: (id: string) => void;
  onLogin: (agent: AgentProfile) => void;
  onManageAgents: () => void;
  // Settings (⌘,).
  onSettings: () => void;
  /** In sidebar order. */
  projects: Project[];
  chatsByProject: Record<string, SessionInfo[]>;
  /** Chats outside any project, newest first. */
  quickChats: SessionInfo[];
  onNewQuickChat: () => void;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onNewProject: () => void;
  onPalette: () => void;
  onNewChat: (projectId: string) => Promise<void>;
  onProjectChange: (p: Project) => void;
  /** Opens the project page with its delete confirmation showing. */
  onDeleteProject: (id: string) => void;
};

export function Sidebar(props: Props) {
  const { agents, agentId, projects, chatsByProject, selection, onSelect, onNewProject } = props;
  const account = agents.find((a) => a.id === agentId);

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="px-1 text-sm font-semibold tracking-tight">yaah</span>
          <Button variant="outline" size="sm" className="h-7 gap-2 px-2 text-muted-foreground" onClick={props.onPalette}>
            <Search /> Search
            <Kbd>{formatKeys(SHORTCUTS.palette.keys)}</Kbd>
          </Button>
        </div>
        <span className="px-1 text-xs text-muted-foreground">Agent</span>
        <div className="flex gap-1.5">
          <Select value={agentId} onValueChange={props.onAgent}>
            <SelectTrigger className="min-w-0 flex-1" aria-label="Agent for new chats">
              <SelectValue placeholder="No agent" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <span>{a.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {a.loggedIn === false ? "not logged in" : (a.email ?? (a.label === a.presetLabel ? "" : a.presetLabel))}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Hint label="Manage agents">
            <Button variant="outline" size="icon" onClick={props.onManageAgents} aria-label="Manage agents">
              <Settings2 />
            </Button>
          </Hint>
        </div>
        {account && account.loggedIn === false && (
          <Button variant="secondary" size="sm" onClick={() => props.onLogin(account)}>
            <LogIn /> Log in “{account.label}”
          </Button>
        )}
      </div>

      <Separator />

      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="px-1 text-xs font-medium text-muted-foreground">Chats</span>
        <Hint label="New quick chat (no project)" shortcut="newChat">
          <Button variant="ghost" size="icon-xs" onClick={props.onNewQuickChat} aria-label="New quick chat">
            <Plus />
          </Button>
        </Hint>
      </div>
      <QuickChats chats={props.quickChats} selection={selection} onSelect={onSelect} onNew={props.onNewQuickChat} />

      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="px-1 text-xs font-medium text-muted-foreground">Projects</span>
        <Hint label="New project" shortcut="newProject">
          <Button variant="ghost" size="icon-xs" onClick={onNewProject} aria-label="New project">
            <Plus />
          </Button>
        </Hint>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <nav className="flex flex-col gap-0.5 px-2 pb-3">
          {projects.length === 0 && (
            <button
              onClick={onNewProject}
              className="rounded-md border border-dashed px-2 py-3 text-left text-xs text-muted-foreground hover:bg-sidebar-accent"
            >
              No projects yet. Create one to group the folders a piece of work spans.
            </button>
          )}
          {projects.map((p) => (
            <ProjectNode
              key={p.id}
              project={p}
              chats={chatsByProject[p.id] ?? []}
              selection={selection}
              onSelect={onSelect}
              account={account}
              onNewChat={props.onNewChat}
              onChange={props.onProjectChange}
              onDelete={props.onDeleteProject}
            />
          ))}
        </nav>
      </ScrollArea>

      <Separator />
      <div className="p-2">
        <button
          onClick={() => onSelect({ kind: "components" })}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar-accent",
            selection?.kind === "components" && "bg-sidebar-accent",
          )}
        >
          <LayoutPanelTop className="size-4 text-muted-foreground" /> Component library
        </button>
        <button
          onClick={props.onSettings}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar-accent"
        >
          <Settings className="size-4 text-muted-foreground" /> Settings
          <Kbd className="ml-auto">{formatKeys(SHORTCUTS.settings.keys)}</Kbd>
        </button>
      </div>
    </aside>
  );
}

function ProjectNode({
  project,
  chats,
  selection,
  onSelect,
  account,
  onNewChat,
  onChange,
  onDelete,
}: {
  project: Project;
  chats: SessionInfo[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  account: AgentProfile | undefined;
  onNewChat: (projectId: string) => Promise<void>;
  onChange: (p: Project) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const selected = selection?.kind === "project" && selection.id === project.id;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <ProjectMenu
        project={project}
        account={account}
        onOpen={() => onSelect({ kind: "project", id: project.id })}
        onNewChat={onNewChat}
        onChange={onChange}
        onDelete={onDelete}
      >
        <div
          className={cn(
            "group flex items-center gap-1 rounded-md pr-2 text-sm hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent",
            selected && "bg-sidebar-accent",
            project.status === "archived" && "opacity-60",
          )}
        >
          <CollapsibleTrigger
            className="grid size-6 shrink-0 place-items-center text-muted-foreground"
            title={open ? "Hide chats" : "Show chats"}
            aria-label={`Chats in ${project.name}`}
          >
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </CollapsibleTrigger>
          <button className="min-w-0 flex-1 truncate py-1.5 text-left" onClick={() => onSelect({ kind: "project", id: project.id })}>
            {project.name}
          </button>
          {project.status !== "ongoing" && (
            <Badge variant="outline" className="h-4 px-1 text-[10px]">
              {project.status}
            </Badge>
          )}
        </div>
      </ProjectMenu>
      <CollapsibleContent>
        <div className="ml-6 flex flex-col gap-0.5 border-l pl-1">
          {chats.length === 0 && <span className="px-2 py-1 text-xs text-muted-foreground">No chats</span>}
          {chats.map((c) => (
            <ChatMenu key={c.sessionId} chat={c} onOpen={() => onSelect({ kind: "chat", id: c.sessionId })}>
              <button
                onClick={() => onSelect({ kind: "chat", id: c.sessionId })}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent",
                  selection?.kind === "chat" && selection.id === c.sessionId && "bg-sidebar-accent",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{c.title}</span>
                {c.running && <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />}
              </button>
            </ChatMenu>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ProjectMenu({
  project,
  account,
  onOpen,
  onNewChat,
  onChange,
  onDelete,
  children,
}: {
  project: Project;
  account: AgentProfile | undefined;
  onOpen: () => void;
  onNewChat: (projectId: string) => Promise<void>;
  onChange: (p: Project) => void;
  onDelete: (id: string) => void;
  children: ReactElement;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>
          <FolderOpen /> Open
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canChat(account)}
          onSelect={() => {
            onNewChat(project.id).catch(console.error);
          }}
        >
          <MessageSquarePlus /> New chat as {account?.label ?? "…"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <CircleDot /> Status
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup
              value={project.status}
              onValueChange={(s) => {
                api.setProjectStatus(project.id, s as ProjectStatus).then(onChange, console.error);
              }}
            >
              {PROJECT_STATUSES.map((s) => (
                <ContextMenuRadioItem key={s} value={s}>
                  {s}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <CopyMenuItem text={project.contextDir}>
          <Copy /> Copy brief folder path
        </CopyMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onDelete(project.id)}>
          <Trash2 /> Delete…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function NewProjectDialog({
  open: isOpen,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, dirs: string[]) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [dirs, setDirs] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [picking, setPicking] = useState(false);

  function reset() {
    setName("");
    setDirs([]);
    setError(null);
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await onCreate(name, dirs);
      reset();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && (reset(), onClose())}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A project groups the repos one piece of work spans. Chats run in the first repo and can work across the others.
            </DialogDescription>
          </DialogHeader>

          <Input
            autoFocus
            aria-label="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={dirs[0] ? `Name (defaults to “${baseName(dirs[0])}”)` : "Name"}
          />

          <div className="flex flex-col gap-1.5">
            {dirs.map((d, i) => (
              <div key={d} className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
                <span className="min-w-0 flex-1 truncate" title={d}>
                  {baseName(d)} <span className="font-mono text-xs text-muted-foreground">{compactPath(d)}</span>
                </span>
                {i === 0 && <Badge variant="secondary">working folder</Badge>}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setDirs(dirs.filter((x) => x !== d))}
                  title="Remove"
                  aria-label={`Remove ${baseName(d)}`}
                >
                  <X />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setPicking(true)}>
              <FolderGit2 /> Add repos
            </Button>
          </div>
          <RepoPicker
            open={picking}
            onClose={() => setPicking(false)}
            exclude={dirs}
            onAdd={(picked) => setDirs((prev) => [...prev, ...picked.filter((d) => !prev.includes(d))])}
          />

          <ErrorText error={error} className="text-sm whitespace-pre-wrap" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => (reset(), onClose())}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || (!name.trim() && dirs.length === 0)}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const QUICK_SHOWN = 6;

/** Chats outside any project: quick analysis, small side things. */
function QuickChats({
  chats,
  selection,
  onSelect,
  onNew,
}: {
  chats: SessionInfo[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  onNew: () => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? chats : chats.slice(0, QUICK_SHOWN);
  if (chats.length === 0)
    return (
      <button
        onClick={onNew}
        className="mx-2 rounded-md border border-dashed px-2 py-2 text-left text-xs text-muted-foreground hover:bg-sidebar-accent"
      >
        Quick chats for small things (a bit of analysis, a side idea) live here, no project needed.
      </button>
    );
  return (
    <div className={cn("flex flex-col gap-0.5 px-2", all && "max-h-64 overflow-y-auto")}>
      {shown.map((c) => {
        // A chat started in a picked folder shows it; scratch folders are just ids.
        const folder = c.cwd.includes("/.yaah/scratch/") ? null : baseName(c.cwd);
        return (
          <ChatMenu key={c.sessionId} chat={c} onOpen={() => onSelect({ kind: "chat", id: c.sessionId })}>
            <button
              onClick={() => onSelect({ kind: "chat", id: c.sessionId })}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm hover:bg-sidebar-accent data-[state=open]:bg-sidebar-accent",
                selection?.kind === "chat" && selection.id === c.sessionId && "bg-sidebar-accent",
              )}
            >
              <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              {folder && <span className="max-w-20 shrink-0 truncate font-mono text-[10px] text-muted-foreground">{folder}</span>}
              {c.running && <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />}
            </button>
          </ChatMenu>
        );
      })}
      {chats.length > QUICK_SHOWN && (
        <button onClick={() => setAll(!all)} className="px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground">
          {all ? "Show fewer" : `Show ${chats.length - QUICK_SHOWN} more`}
        </button>
      )}
    </div>
  );
}
