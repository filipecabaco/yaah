import { memo, useState, type ReactElement } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Copy,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  LayoutPanelTop,
  Loader2,
  LogIn,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
  Settings,
} from "lucide-react";
import { AgentMenu } from "@/components/agent-choice";
import { Wordmark } from "@/components/brand/mark";
import { ChatMenu, CopyMenuItem } from "@/components/menus";
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
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { api, canChat, PROJECT_STATUSES, type AgentProfile, type Project, type ProjectStatus, type SessionInfo } from "@/lib/api";
import { baseName } from "@/lib/format";
import type { Selection } from "@/hooks/use-yaah";
import { useTrafficLights } from "@/hooks/use-titlebar";
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
  /** A quick chat with this agent rather than the one picked above. */
  onNewQuickChatWith: (agentId: string) => void;
  onNewChatInFolder: () => void;
  selection: Selection;
  /** The project ⌘N starts a chat in: the open one, or the open chat's. */
  activeProjectId: string | null;
  onSelect: (s: Selection) => void;
  onNewProject: () => void;
  onPalette: () => void;
  onNewChat: (projectId: string) => Promise<unknown>;
  onProjectChange: (p: Project) => void;
  /** Opens the project page with its name ready to edit. */
  onRenameProject: (id: string) => void;
  /** Opens the project page and the repo picker for it. */
  onAddRepos: (id: string) => void;
  /** Opens the project page with its delete confirmation showing. */
  onDeleteProject: (id: string) => void;
};

/** Memoised: the app passes stable callbacks, so it re-renders only when chats, projects, agents or the selection change. */
export const Sidebar = memo(function Sidebar(props: Props) {
  const { agents, agentId, projects, chatsByProject, selection, onSelect, onNewProject } = props;
  const account = agents.find((a) => a.id === agentId);
  const trafficLights = useTrafficLights();

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex flex-col gap-2 p-3">
        {/* Drags the window (the logo and Search stay clickable); on macOS it leaves room for the traffic lights. */}
        <div data-tauri-drag-region="deep" className={cn("flex items-center justify-between gap-2", trafficLights && "pl-[68px]")}>
          <span data-tauri-drag-region="false" className="inline-flex">
            <Wordmark className="px-1 text-sm" />
          </span>
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

      <NewMenu
        quickChatShortcut={!props.activeProjectId}
        onNewQuickChat={props.onNewQuickChat}
        agents={agents}
        onNewQuickChatWith={props.onNewQuickChatWith}
        onNewChatInFolder={props.onNewChatInFolder}
        onNewProject={onNewProject}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-3 pt-3 pb-1">
            <span className="px-1 text-xs font-medium text-muted-foreground">Chats</span>
            <div className="flex items-center">
              <Hint label="New quick chat (no project)" shortcut="newChat">
                <Button variant="ghost" size="icon-xs" onClick={props.onNewQuickChat} aria-label="New quick chat">
                  <Plus />
                </Button>
              </Hint>
              {agents.length > 1 && (
                <AgentMenu
                  agents={agents}
                  heading="Quick chat with…"
                  current={agentId}
                  currentHint={!props.activeProjectId && formatKeys(SHORTCUTS.newChat.keys)}
                  align="end"
                  onPick={props.onNewQuickChatWith}
                >
                  <Button variant="ghost" size="icon-xs" aria-label="Start a quick chat with…" title="Quick chat with…">
                    <ChevronDown />
                  </Button>
                </AgentMenu>
              )}
            </div>
          </div>
          <QuickChats chats={props.quickChats} selection={selection} onSelect={onSelect} onNew={props.onNewQuickChat} />

          <NewMenu onNewProject={onNewProject}>
            <div className="flex items-center justify-between px-3 pt-3 pb-1">
              <span className="px-1 text-xs font-medium text-muted-foreground">Projects</span>
              <Hint label="New project" shortcut="newProject">
                <Button variant="ghost" size="icon-xs" onClick={onNewProject} aria-label="New project">
                  <Plus />
                </Button>
              </Hint>
            </div>
          </NewMenu>

          {/* Radix lays the viewport's content out as a table, which grows to the longest name; block keeps names truncated. */}
          <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
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
                  // Its own agent while that exists, else the one picked above (use-yaah `agentFor`).
                  account={agents.find((a) => a.id === p.agentId) ?? account}
                  active={p.id === props.activeProjectId}
                  onNewChat={props.onNewChat}
                  onChange={props.onProjectChange}
                  onRename={props.onRenameProject}
                  onAddRepos={props.onAddRepos}
                  onDelete={props.onDeleteProject}
                />
              ))}
            </nav>
          </ScrollArea>
        </div>
      </NewMenu>

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
});

function ProjectNode({
  project,
  chats,
  selection,
  onSelect,
  account,
  active,
  onNewChat,
  onChange,
  onRename,
  onAddRepos,
  onDelete,
}: {
  project: Project;
  chats: SessionInfo[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  account: AgentProfile | undefined;
  active: boolean;
  onNewChat: (projectId: string) => Promise<unknown>;
  onChange: (p: Project) => void;
  onRename: (id: string) => void;
  onAddRepos: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const selected = selection?.kind === "project" && selection.id === project.id;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <ProjectMenu
        project={project}
        account={account}
        active={active}
        onOpen={() => onSelect({ kind: "project", id: project.id })}
        onNewChat={onNewChat}
        onChange={onChange}
        onRename={onRename}
        onAddRepos={onAddRepos}
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

/**
 * New chats and projects, for the Chats header and the sidebar's empty space;
 * only "New project…" when no chat handlers are given (the Projects header).
 */
function NewMenu({
  quickChatShortcut,
  onNewQuickChat,
  agents,
  onNewQuickChatWith,
  onNewChatInFolder,
  onNewProject,
  children,
}: {
  /** ⌘N starts a quick chat (no project is open). */
  quickChatShortcut?: boolean;
  onNewQuickChat?: () => void;
  /** With `onNewQuickChatWith`: a "Quick chat with" submenu of these agents. */
  agents?: AgentProfile[];
  onNewQuickChatWith?: (agentId: string) => void;
  onNewChatInFolder?: () => void;
  onNewProject: () => void;
  children: ReactElement;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {onNewQuickChat && (
          <ContextMenuItem onSelect={onNewQuickChat}>
            <MessageSquarePlus /> New quick chat
            {quickChatShortcut && <ContextMenuShortcut>{formatKeys(SHORTCUTS.newChat.keys)}</ContextMenuShortcut>}
          </ContextMenuItem>
        )}
        {onNewQuickChatWith && agents && agents.length > 1 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Bot /> Quick chat with
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              {agents.map((a) => (
                <ContextMenuItem key={a.id} onSelect={() => onNewQuickChatWith(a.id)}>
                  {a.label}
                  {a.loggedIn === false && <span className="text-xs text-muted-foreground">not logged in</span>}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {onNewChatInFolder && (
          <ContextMenuItem onSelect={onNewChatInFolder}>
            <FolderOpen /> New chat in a folder…
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={onNewProject}>
          <FolderPlus /> New project…
          <ContextMenuShortcut>{formatKeys(SHORTCUTS.newProject.keys)}</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ProjectMenu({
  project,
  account,
  active,
  onOpen,
  onNewChat,
  onChange,
  onRename,
  onAddRepos,
  onDelete,
  children,
}: {
  project: Project;
  account: AgentProfile | undefined;
  /** ⌘N starts a chat in this project. */
  active: boolean;
  onOpen: () => void;
  onNewChat: (projectId: string) => Promise<unknown>;
  onChange: (p: Project) => void;
  onRename: (id: string) => void;
  onAddRepos: (id: string) => void;
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
          {active && <ContextMenuShortcut>{formatKeys(SHORTCUTS.newChat.keys)}</ContextMenuShortcut>}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onRename(project.id)}>
          <Pencil /> Rename…
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onAddRepos(project.id)}>
          <FolderGit2 /> Add repos…
        </ContextMenuItem>
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
        <ContextMenuSeparator />
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
