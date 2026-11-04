import { memo, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from "react";
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
  SquareTerminal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
  Settings,
} from "lucide-react";
import { openInTerminalApp } from "@/lib/terminal-api";
import { AgentMenu } from "@/components/agent-choice";
import { Mark, Wordmark } from "@/components/brand/mark";
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
import {
  agentDetail,
  api,
  canChat,
  needsProviderFix,
  PROJECT_STATUSES,
  SIDEBAR,
  type AgentProfile,
  type Project,
  type ProjectStatus,
  type SessionInfo,
} from "@/lib/api";
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
  /** Hidden to a thin strip (⌘B). */
  collapsed: boolean;
  /** In CSS pixels, 220–480. */
  width: number;
  onToggle: () => void;
  /** A new width, once a drag of its edge ends (or per key). */
  onWidth: (width: number) => void;
};

/** Memoised: the app passes stable callbacks, so it re-renders only when chats, projects, agents or the selection change. */
export const Sidebar = memo(function Sidebar(props: Props) {
  const { agents, agentId, projects, chatsByProject, selection, onSelect, onNewProject } = props;
  const account = agents.find((a) => a.id === agentId);
  const trafficLights = useTrafficLights();
  // While its edge is dragged, only the sidebar re-renders; the app gets the width when the drag ends.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const width = dragWidth ?? props.width;

  const hidden = props.collapsed;

  // Hidden (⌘B), it slides to nothing, as in Finder or Notes; the main area's title bar (`CollapsedTitleBar`) takes over.
  return (
    <div className="relative flex shrink-0" data-collapsed={hidden || undefined}>
      <div
        className={cn("overflow-hidden", dragWidth == null && "transition-[width] duration-200 ease-out motion-reduce:transition-none")}
        style={{ width: hidden ? 0 : width }}
        inert={hidden}
        aria-hidden={hidden || undefined}
      >
        <aside aria-label="Sidebar" className="@container/sidebar flex h-full flex-col border-r bg-sidebar text-sidebar-foreground" style={{ width }}>
          <div className="flex flex-col gap-2 p-3">
            {/* Row 1 drags the window and, on macOS, holds the traffic lights; the logo follows them and Hide stays inside the edge. */}
            <div data-tauri-drag-region="deep" className={cn("flex h-7 min-w-0 items-center justify-between gap-2", trafficLights && "pl-[68px]")}>
              <span data-tauri-drag-region="false" className="inline-flex min-w-0">
                <Wordmark className="px-1 text-sm" />
              </span>
              <Hint label="Hide the sidebar" shortcut="toggleSidebar">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground"
                  onClick={props.onToggle}
                  aria-label="Hide the sidebar"
                >
                  <PanelLeftClose />
                </Button>
              </Hint>
            </div>
            <Button variant="outline" size="sm" className="h-7 w-full justify-start gap-2 px-2 text-muted-foreground" onClick={props.onPalette}>
              <Search /> Search
              <Kbd className="ml-auto">{formatKeys(SHORTCUTS.palette.keys)}</Kbd>
            </Button>
            <span className="px-1 text-xs text-muted-foreground">Agent</span>
            <div className="flex gap-1.5">
              <Select value={agentId} onValueChange={props.onAgent}>
                {/* The email is clipped in a narrow sidebar or at a large interface size: the tooltip has it whole (LV-2). */}
                <SelectTrigger
                  className="min-w-0 flex-1"
                  aria-label="Agent for new chats"
                  title={account ? [account.label, agentDetail(account)].filter(Boolean).join(" · ") : undefined}
                >
                  <SelectValue placeholder="No agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span>{a.label}</span>
                      <span className="min-w-0 truncate text-xs text-muted-foreground">{agentDetail(a)}</span>
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
                {needsProviderFix(account) ? (
                  <>
                    <Settings2 /> Fix in Settings → Model providers
                  </>
                ) : (
                  <>
                    <LogIn /> Log in “{account.label}”
                  </>
                )}
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
      </div>
      {!hidden && (
        <ResizeEdge
          width={width}
          onDrag={setDragWidth}
          onDone={(w) => {
            setDragWidth(null);
            props.onWidth(w);
          }}
        />
      )}
    </div>
  );
});

const clampWidth = (w: number) => Math.round(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, w)));

/**
 * The sidebar's right edge: drag it (220–480 px), arrow keys (Shift: further), Home/End,
 * double-click for the default width.
 */
function ResizeEdge({ width, onDrag, onDone }: { width: number; onDrag: (w: number) => void; onDone: (w: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const start = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = e.clientX;
    let w = width;
    const move = (ev: globalThis.PointerEvent) => {
      w = clampWidth(width + ev.clientX - from);
      onDrag(w);
    };
    const up = () => {
      stop.current?.();
      onDone(w);
    };
    stop.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      stop.current = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    setDragging(true);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    const to: Record<string, number> = { ArrowLeft: width - step, ArrowRight: width + step, Home: SIDEBAR.min, End: SIDEBAR.max };
    if (!(e.key in to) || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    onDone(clampWidth(to[e.key]));
  };
  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        aria-valuenow={width}
        aria-valuemin={SIDEBAR.min}
        aria-valuemax={SIDEBAR.max}
        tabIndex={0}
        title="Drag to resize · double-click for the default width"
        data-dragging={dragging || undefined}
        className="group absolute inset-y-0 -right-[4px] z-30 flex w-[7px] cursor-col-resize touch-none justify-center outline-none"
        onPointerDown={start}
        onKeyDown={onKeyDown}
        onDoubleClick={() => onDone(SIDEBAR.default)}
      >
        <div className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-ring group-focus-visible:bg-ring group-data-dragging:bg-ring" />
      </div>
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </>
  );
}

/**
 * With the sidebar hidden (⌘B), the main area's top row is the title bar, as in Finder or Notes:
 * on macOS a gutter for the traffic lights, then Show sidebar, the logo and Search. It drags the
 * window (its buttons stay buttons). Always rendered, so it grows and fades in as the sidebar slides
 * away instead of jumping; 52 px tall, like the sidebar's own first row, so the lights sit centred in it.
 */
export function CollapsedTitleBar({ shown, onToggle, onPalette }: { shown: boolean; onToggle: () => void; onPalette: () => void }) {
  const trafficLights = useTrafficLights();
  return (
    <div
      className={cn(
        "grid shrink-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
        shown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
      inert={!shown}
      aria-hidden={!shown || undefined}
      data-shown={shown || undefined}
    >
      <div className="min-h-0 overflow-hidden">
        <header
          data-tauri-drag-region="deep"
          aria-label="Title bar"
          className={cn("flex h-[52px] min-w-0 items-center gap-1.5 border-b px-3", trafficLights && "pl-[80px]")}
        >
          <Hint label="Show the sidebar" shortcut="toggleSidebar">
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={onToggle} aria-label="Show the sidebar">
              <PanelLeftOpen />
            </Button>
          </Hint>
          <Mark className="size-4 text-foreground" title="yaah" />
          <Button variant="outline" size="sm" className="ml-2 h-7 gap-2 px-2 text-muted-foreground" onClick={onPalette}>
            <Search /> Search
            <Kbd>{formatKeys(SHORTCUTS.palette.keys)}</Kbd>
          </Button>
        </header>
      </div>
    </div>
  );
}

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
            <Badge variant="outline" className="h-4 px-1 text-2xs">
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
                  {a.loggedIn === false && <span className="text-xs text-muted-foreground">{agentDetail(a)}</span>}
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
        {project.dirs[0] && (
          <ContextMenuItem onSelect={() => openInTerminalApp(project.dirs[0])}>
            <SquareTerminal /> Open in terminal
          </ContextMenuItem>
        )}
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
              {folder && <span className="max-w-20 shrink-0 truncate font-mono text-2xs text-muted-foreground">{folder}</span>}
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
