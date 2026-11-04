import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, FolderGit2, MessageSquarePlus, SquareTerminal } from "lucide-react";
import { AgentMenu } from "@/components/agent-choice";
import { Mark } from "@/components/brand/mark";
import { Chat, StartingChat } from "@/components/chat";
import { focusComposer } from "@/components/chat-context";
import { ErrorText } from "@/components/error-text";
import { CommandPalette, type PalettePage } from "@/components/command-palette";
import { AgentSetupDialog, FirstRunSetup, type SettingsTab, type SettingsTarget } from "@/components/agent-setup";
import { AppContextMenu, ChatActionsProvider } from "@/components/menus";
import { ShortcutsDialog } from "@/components/shortcuts";
import type { NewProjectMode } from "@/components/new-project-dialog";
import { preloadSettings } from "@/components/settings/tab-code";
import { PanePicker } from "@/components/pane-picker";
import { PaneGrid } from "@/components/panes";
import { DiffPane } from "@/components/diff/diff-pane";
import { TerminalPane } from "@/components/terminal/terminal-pane";
import { useTerminals } from "@/components/terminal/use-terminals";
import { focusMain, focusPaneDom } from "@/lib/pane-focus";
import { CollapsedTitleBar, Sidebar } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { contentKey, useYaah, type Selection } from "@/hooks/use-yaah";
import { TranscriptsContext } from "@/hooks/use-transcript";
import { api, canChat, mayListSessions, type AgentProfile, type SessionInfo } from "@/lib/api";
import { onOpenAgentSwitch, onOpenComponent, onOpenSettings } from "@/lib/app-events";
import { baseName } from "@/lib/format";
import { formatKeys, SHORTCUTS } from "@/lib/shortcuts";
import { stepFontSize } from "@/lib/fonts";
import { preloadable, preloadAll, whenIdle } from "@/lib/preload";

// Not needed at startup, so not in the main chunk: fetched once the app is idle.
const ComponentsView = preloadable(() => import("@/components/components-view").then((m) => m.ComponentsView));
const ProjectView = preloadable(() => import("@/components/project-view").then((m) => m.ProjectView));
const LoginDialog = preloadable(() => import("@/components/login-dialog").then((m) => m.LoginDialog));
const NewProjectDialog = preloadable(() => import("@/components/new-project-dialog").then((m) => m.NewProjectDialog));
const RepoPicker = preloadable(() => import("@/components/repo-picker").then((m) => m.RepoPicker));

/** True from the first time `on` is, so a dialog's code loads only once it's wanted, and then stays for its close animation. */
function useOnceOn(on: boolean): boolean {
  const [was, setWas] = useState(on);
  if (on && !was) setWas(true);
  return was || on;
}

export default function App() {
  const y = useYaah();
  const [loginFor, setLoginAgent] = useState<AgentProfile | null>(null);
  const [setup, setSetup] = useState<SettingsTarget | null>(null);
  // A profile on a model provider has no login of its own: its provider is fixed in Settings → Model providers.
  const setLoginFor = useCallback(
    (a: AgentProfile | null) => (a?.provider ? setSetup({ kind: "providers", id: a.provider.providerId }) : setLoginAgent(a)),
    [],
  );
  // The New project dialog, open on a mode (null: closed).
  const [creatingProject, setCreatingProject] = useState<NewProjectMode | null>(null);
  const [addingRepos, setAddingRepos] = useState(false);
  const [palette, setPalette] = useState<PalettePage | null>(null);
  const [help, setHelp] = useState(false);
  // Project whose delete confirmation the sidebar menu asked for.
  const [askDelete, setAskDelete] = useState<string | null>(null);
  // Project whose name the sidebar menu's Rename… asked to edit.
  const [askRename, setAskRename] = useState<string | null>(null);
  // Why the chat of a project just started from an issue didn't open (shown on its page).
  const [startNote, setStartNote] = useState<{ projectId: string; message: string } | null>(null);
  // Component a chat asked the Component library to show.
  const [showComponent, setShowComponent] = useState<string | null>(null);
  const agent = y.agents.find((a) => a.id === y.agentId);
  const project = y.activeProject;
  const chat = y.activeChat;
  const clearAskDelete = useCallback(() => setAskDelete(null), []);
  const clearAskRename = useCallback(() => setAskRename(null), []);
  const clearShowComponent = useCallback(() => setShowComponent(null), []);
  const agents = y.agents;
  // Stable, so finished chat entries (which get it) don't re-render with the app.
  const loginById = useCallback((id: string) => setLoginFor(agents.find((a) => a.id === id) ?? null), [agents, setLoginFor]);
  /** Start a chat if its agent (`id`, else the sidebar's) can; otherwise log it in, or add one. */
  const withAgent = useCallback(
    (start: () => Promise<unknown>, id?: string) => {
      const a = id ? agents.find((x) => x.id === id) : agent;
      if (!a) return setSetup({ kind: "add" });
      if (!canChat(a)) return setLoginFor(a);
      start().catch(console.error);
    },
    [agent, agents, setLoginFor],
  );
  // Everything below acts on the focused pane: selecting shows it there.
  const panes = y.panes;
  // Terminal panes: ⌘T, the home screen, the picker, ⌘K and tool cards' "Open as pane" open them.
  const terminals = useTerminals(y);
  const select = y.setSelection;
  // Terminal and diff panes, listed in the sidebar beside the chats (stable while the tree is).
  const openPanes = useMemo(() => panes.panes.filter((p) => p.content?.kind === "terminal" || p.content?.kind === "diff"), [panes.panes]);
  const openChat = (id: string) => select({ kind: "chat", id });
  const selection = y.selection;
  // The Component library takes a pane; closing it goes back to what that pane showed before (use-layout.ts).
  const openLibrary = useCallback(() => select({ kind: "components" }), [select]);
  const { closeLibrary, focusedId, setPaneContent, close: closePane, focus: focusPane } = panes;
  /** The sidebar's selection, into the focused pane; its "Component library" entry toggles the library there. */
  const focusedKind = selection?.kind;
  const selectFromSidebar = useCallback(
    (s: Selection) => {
      if (s?.kind !== "components") return select(s);
      if (focusedKind === "components") closeLibrary(focusedId());
      else openLibrary();
    },
    [select, openLibrary, closeLibrary, focusedId, focusedKind],
  );
  // Stable, so the (memoised) sidebar doesn't re-render with the rest of the app.
  const { newQuickChat, newChatInFolder, agentId } = y;
  const sidebar = {
    onManageAgents: useCallback(() => setSetup({ kind: "manage", id: agentId || undefined }), [agentId]),
    onSettings: useCallback(() => setSetup({ kind: "settings" }), []),
    onNewQuickChat: useCallback(() => withAgent(() => newQuickChat()), [withAgent, newQuickChat]),
    onNewQuickChatWith: useCallback((id: string) => withAgent(() => newQuickChat(undefined, id), id), [withAgent, newQuickChat]),
    onNewChatInFolder: useCallback(() => withAgent(() => newChatInFolder()), [withAgent, newChatInFolder]),
    onNewProject: useCallback(() => setCreatingProject("name"), []),
    onPalette: useCallback(() => setPalette({ kind: "root" }), []),
    onRenameProject: useCallback(
      (id: string) => {
        select({ kind: "project", id });
        setAskRename(id);
      },
      [select],
    ),
    onAddRepos: useCallback(
      (id: string) => {
        select({ kind: "project", id });
        setAddingRepos(true);
      },
      [select],
    ),
    onDeleteProject: useCallback(
      (id: string) => {
        select({ kind: "project", id });
        setAskDelete(id);
      },
      [select],
    ),
  };

  /** Close pane `id` (the last one goes home instead); the keyboard stays in the pane that remains. */
  const closePaneById = useCallback(
    (id: string) => {
      if (closePane(id)) focusPaneDom(focusedId());
      else setPaneContent(id, null);
    },
    [closePane, focusedId, setPaneContent],
  );
  /** The sidebar's open terminal and diff panes: focus one, or close it. */
  const focusOpenPane = useCallback(
    (id: string) => {
      focusPane(id);
      focusPaneDom(id);
    },
    [focusPane],
  );

  /** Previous/next chat in sidebar order; from a project page, start in that project. */
  function stepChat(d: 1 | -1) {
    const list = y.chatOrder;
    const i = list.findIndex((c) => c.sessionId === chat?.sessionId);
    if (i >= 0) return list.length && openChat(list[(i + d + list.length) % list.length].sessionId);
    const pool = (project && y.chatsByProject[project.id]?.length ? y.chatsByProject[project.id] : list) ?? [];
    const target = d > 0 ? pool[0] : pool[pool.length - 1];
    if (target) openChat(target.sessionId);
  }

  // Cards in a chat (e.g. MCP notices) can open Settings on a tab.
  useEffect(() => onOpenSettings((tab) => setSetup({ kind: "settings", tab: tab as SettingsTab })), []);
  // A chat's agent badge and its /agent command open the agent picker for that chat.
  useEffect(() => onOpenAgentSwitch((sessionId) => setPalette({ kind: "chatAgent", sessionId })), []);
  // A rendered UI's menu can open its component in the library.
  useEffect(
    () =>
      onOpenComponent((name) => {
        setShowComponent(name);
        openLibrary();
      }),
    [openLibrary],
  );

  useShortcuts({
    palette: () => {
      setHelp(false);
      setPalette((p) => (p ? null : { kind: "root" }));
    },
    help: () => {
      setPalette(null);
      setHelp((h) => !h);
    },
    settings: () => {
      setPalette(null);
      setHelp(false);
      setSetup((s) => (s ? null : { kind: "settings" }));
    },
    // In a project: a chat there. Anywhere else: a quick chat outside any project.
    newChat: () => (project ? withAgent(() => y.newChat(project.id), y.agentFor(project.id)) : withAgent(() => y.newQuickChat())),
    newProject: () => setCreatingProject("name"),
    focusComposer,
    stop: () => {
      if (chat?.running) api.cancelTurn(chat.sessionId).catch((e: unknown) => console.error("could not stop the turn", e));
    },
    prevChat: () => stepChat(-1),
    nextChat: () => stepChat(1),
    jumpChat: ({ n }) => {
      const target = project && y.chatsByProject[project.id]?.[(n ?? 1) - 1];
      if (target) openChat(target.sessionId);
    },
    // Split panes: a new pane opens on the picker, with the keyboard in it.
    splitRight: () => focusPaneDom(panes.split("row")),
    splitDown: () => focusPaneDom(panes.split("column")),
    balancePanes: panes.balance,
    // The last pane stays; there ⌘W closes the library, as Esc does.
    closePane: () => {
      if (panes.close()) focusPaneDom(panes.focusedId());
      else if (selection?.kind === "components") closeLibrary(panes.focusedId());
    },
    focusPane: ({ dir }) => {
      const to = dir && panes.move(dir);
      if (to) focusPaneDom(to);
    },
    toggleSidebar: panes.toggleSidebar,
    newTerminal: terminals.openHere,
    sizeUp: () => void stepFontSize(1),
    sizeDown: () => void stepFontSize(-1),
    sizeReset: () => void stepFontSize(0),
  });

  const chatActions = useMemo(
    () => ({
      activeId: chat?.sessionId ?? null,
      rename: (c: SessionInfo) => setPalette({ kind: "rename", chat: c }),
      remove: (c: SessionInfo) => setPalette({ kind: "delete", chat: c }),
      move: (c: SessionInfo) => setPalette({ kind: "move", chat: c }),
      promote: (c: SessionInfo) => setPalette({ kind: "promote", chat: c }),
    }),
    [chat?.sessionId],
  );

  useEffect(
    () => whenIdle(() => void preloadAll([ComponentsView, ProjectView, LoginDialog, NewProjectDialog, RepoPicker, { preload: preloadSettings }])),
    [],
  );
  const loginWanted = useOnceOn(loginFor != null);
  const newProjectWanted = useOnceOn(creatingProject != null);
  const reposWanted = useOnceOn(addingRepos);

  const login = loginWanted && (
    <LoginDialog
      agent={loginFor}
      onClose={() => setLoginFor(null)}
      onEditAgent={(a) => {
        setLoginFor(null);
        setSetup({ kind: "manage", id: a.id });
      }}
    />
  );

  const home = (
    <div className="flex min-w-0 flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <Mark assemble className="size-16 text-foreground" title="yaah" />
        <p className="text-sm text-pretty text-muted-foreground">
          Start a quick chat for something small, or a project when the work spans several repos.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <div className="flex">
            <Button className={y.agents.length > 1 ? "rounded-r-none" : undefined} onClick={() => withAgent(() => y.newQuickChat())}>
              <MessageSquarePlus /> Quick chat <Kbd className="ml-1">{formatKeys(SHORTCUTS.newChat.keys)}</Kbd>
            </Button>
            {y.agents.length > 1 && (
              <AgentMenu
                agents={y.agents}
                heading="Quick chat with…"
                current={y.agentId}
                currentHint={formatKeys(SHORTCUTS.newChat.keys)}
                onPick={sidebar.onNewQuickChatWith}
                extra={y.agents.some(mayListSessions) ? { label: "Resume a session…", onSelect: () => setPalette({ kind: "resume" }) } : undefined}
              >
                <Button className="rounded-l-none border-l-primary-foreground/20 px-2" aria-label="Start a quick chat with…">
                  <ChevronDown />
                </Button>
              </AgentMenu>
            )}
          </div>
          <Button variant="outline" onClick={() => setCreatingProject("name")}>
            <FolderGit2 /> New project <Kbd className="ml-1">{formatKeys(SHORTCUTS.newProject.keys)}</Kbd>
          </Button>
          <Button variant="outline" onClick={() => terminals.open({}, "here")}>
            <SquareTerminal /> New terminal <Kbd className="ml-1">{formatKeys(SHORTCUTS.newTerminal.keys)}</Kbd>
          </Button>
        </div>
      </div>
    </div>
  );

  /** What pane `p` shows, and its name for assistive tech. Built here so a divider drag reuses the same elements. */
  const contents: Record<string, ReactNode> = {};
  const labels: Record<string, string> = {};
  for (const p of panes.panes) {
    const c = p.content;
    const focused = p.id === panes.layout.focused;
    const blank = <div className="min-w-0 flex-1" />;
    // A chat starting here covers what the pane showed, until it opens (or the pane moves on).
    const start = y.starting[p.id];
    if (start && contentKey(c) === start.over) {
      const label = y.agents.find((a) => a.id === start.agentId)?.label ?? start.agentId;
      labels[p.id] = `Starting a chat with ${label}`;
      contents[p.id] = <StartingChat start={start} agents={y.agents} onDismiss={() => y.dismissStart(p.id)} />;
      continue;
    }
    if (c?.kind === "components") {
      labels[p.id] = "Component library";
      contents[p.id] = (
        <Suspense fallback={blank}>
          <ComponentsView
            initial={focused ? showComponent : null}
            onInitialSeen={clearShowComponent}
            onClose={() => closeLibrary(p.id)}
            escapeCloses={focused}
          />
        </Suspense>
      );
    } else if (c?.kind === "chat") {
      const s = y.sessions[c.id];
      const own = s?.projectId ? (y.projects.find((x) => x.id === s.projectId) ?? null) : null;
      labels[p.id] = `Chat: ${s?.title ?? "loading"}`;
      contents[p.id] = s ? (
        <Chat
          session={s}
          agents={y.agents}
          project={own}
          onOpenProject={(id) => setPaneContent(p.id, { kind: "project", id })}
          onLogin={loginById}
          pane={p.id}
        />
      ) : y.sessionsLoaded ? (
        home
      ) : (
        blank
      );
    } else if (c?.kind === "project") {
      const pr = y.projects.find((x) => x.id === c.id);
      labels[p.id] = `Project: ${pr?.name ?? "loading"}`;
      contents[p.id] = pr ? (
        <Suspense fallback={blank}>
          <ProjectView
            project={pr}
            chats={y.chatsByProject[pr.id] ?? []}
            agents={y.agents}
            account={y.agents.find((a) => a.id === y.agentFor(pr.id))}
            onChange={y.putProject}
            onDelete={y.deleteProject}
            onOpenChat={(id) => setPaneContent(p.id, { kind: "chat", id })}
            onNewChat={(id, agentId) => {
              setStartNote(null);
              return y.newChat(id, agentId);
            }}
            onLogin={setLoginFor}
            // Asked from the sidebar, which acts on the focused pane.
            askDelete={focused && askDelete === pr.id}
            onAskDeleteSeen={clearAskDelete}
            askRename={focused && askRename === pr.id}
            onAskRenameSeen={clearAskRename}
            notice={
              startNote?.projectId === pr.id
                ? `Started from ${pr.link?.id ?? "the issue"}, but its chat didn't open: ${startNote.message}`
                : undefined
            }
          />
        </Suspense>
      ) : (
        blank
      );
    } else if (c?.kind === "terminal") {
      labels[p.id] = `Terminal: ${c.cwd ?? "default folder"}`;
      contents[p.id] = (
        <TerminalPane
          pane={p.id}
          content={c}
          focused={focused}
          onContent={(next) => setPaneContent(p.id, next)}
          onClose={() => {
            if (panes.close(p.id)) focusPaneDom(panes.focusedId());
            else setPaneContent(p.id, null);
          }}
        />
      );
    } else if (c?.kind === "diff") {
      labels[p.id] = `Diff: ${c.cwd ? baseName(c.cwd) : "pick a folder"}`;
      contents[p.id] = (
        <DiffPane
          pane={p.id}
          content={c}
          chats={y.chatOrder}
          projects={y.orderedProjects}
          onContent={(next) => setPaneContent(p.id, next)}
          onClose={() => closePaneById(p.id)}
        />
      );
    } else if (c?.kind === "picker") {
      labels[p.id] = "Open in this pane";
      contents[p.id] = (
        <PanePicker
          agents={y.agents}
          agentId={y.agentId}
          chats={y.chatOrder}
          projects={y.orderedProjects}
          autoFocus={focused}
          onNewChat={(id, repos) => withAgent(() => y.newQuickChat(undefined, id, repos), id)}
          onNewProject={() => setCreatingProject("name")}
          onOpen={(s) => setPaneContent(p.id, s)}
          onNewTerminal={(cwd) => setPaneContent(p.id, { kind: "terminal", cwd })}
          onNewDiff={(cwd) => setPaneContent(p.id, { kind: "diff", cwd })}
          onResume={(accountId, s) => y.resumeSession(accountId, s, p.id)}
          // Esc on an empty search: the pane goes (the last one goes home instead).
          onClose={() => {
            if (panes.close(p.id)) focusPaneDom(panes.focusedId());
            else setPaneContent(p.id, null);
          }}
        />
      );
    } else {
      labels[p.id] = "Home";
      contents[p.id] = home;
    }
  }

  // Starting: the same sliding mark index.html shows before any script ran, until the agents (and the layout) are in.
  if ((!y.agentsLoaded || !panes.loaded) && !y.loadError) {
    return (
      <div className="grid h-screen place-items-center" role="status" aria-label="Starting yaah">
        <Mark loading className="size-14 text-foreground" />
      </div>
    );
  }

  // First run: nothing to chat with until an agent is set up.
  if (y.agentsLoaded && y.agents.length === 0) {
    return (
      <TooltipProvider delayDuration={400}>
        <FirstRunSetup agents={y.agents} defaultId={y.defaultAgentId} onLogin={setLoginFor} onSaved={(a) => y.setAgentId(a.id)} />
        <Suspense>{login}</Suspense>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={400}>
      <TranscriptsContext.Provider value={y.transcripts}>
        <ChatActionsProvider value={chatActions}>
          <AppContextMenu>
            <div className="flex h-screen overflow-hidden bg-background text-foreground">
              {/* First on the page: past the sidebar's dozen stops to the focused pane (SR-5). */}
              <a
                href="#main"
                className="sr-only rounded-md bg-background text-sm font-medium shadow-md ring-3 ring-ring focus:not-sr-only focus:fixed focus:top-12 focus:left-3 focus:z-[100] focus:px-3 focus:py-2"
                onClick={(e) => {
                  e.preventDefault();
                  focusMain(panes.focusedId());
                }}
              >
                Skip to main content
              </a>
              {y.loadError != null && (
                <div className="fixed inset-x-0 top-0 z-50 border-b bg-background px-4 py-2">
                  <ErrorText error={y.loadError} prefix="Couldn't load your agents, projects and chats: " />
                </div>
              )}
              <Sidebar
                agents={y.agents}
                agentId={y.agentId}
                onAgent={y.setAgentId}
                onLogin={setLoginFor}
                projects={y.orderedProjects}
                chatsByProject={y.chatsByProject}
                quickChats={y.quickChats}
                selection={y.selection}
                activeProjectId={project?.id ?? null}
                onSelect={selectFromSidebar}
                onNewChat={y.newChat}
                onProjectChange={y.putProject}
                collapsed={panes.sidebar.collapsed}
                width={panes.sidebar.width}
                onToggle={panes.toggleSidebar}
                onWidth={panes.setSidebarWidth}
                openPanes={openPanes}
                focusedPaneId={panes.layout.focused}
                onFocusPane={focusOpenPane}
                onClosePane={closePaneById}
                {...sidebar}
              />

              <div className="flex min-w-0 flex-1 flex-col">
                <CollapsedTitleBar shown={panes.sidebar.collapsed} onToggle={panes.toggleSidebar} onPalette={sidebar.onPalette} />
                {/* The one main landmark: every pane, whatever it shows (they're sections in it). */}
                <main id="main" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none">
                  <PaneGrid
                    layout={panes.layout}
                    contents={contents}
                    labels={labels}
                    onFocus={panes.focus}
                    onResize={panes.resize}
                    onClose={(id) => {
                      if (panes.close(id)) focusPaneDom(panes.focusedId());
                    }}
                  />
                </main>
              </div>

              <CommandPalette
                page={palette}
                onPage={setPalette}
                y={y}
                onNewProject={() => setCreatingProject("name")}
                onNewProjectFromItem={() => setCreatingProject("issue")}
                onAddRepos={() => setAddingRepos(true)}
                onLogin={setLoginFor}
                onAddAgent={() => setSetup({ kind: "add" })}
                onManageAgents={() => setSetup({ kind: "manage", id: y.agentId || undefined })}
                onIntegrations={(service) => setSetup({ kind: "integrations", service })}
                onSettings={(tab) => setSetup({ kind: "settings", tab })}
                onHelp={() => setHelp(true)}
                terminals={terminals}
              />
              <ShortcutsDialog open={help} onClose={() => setHelp(false)} />
              <Suspense>
                {newProjectWanted && (
                  <NewProjectDialog
                    open={creatingProject != null}
                    mode={creatingProject ?? "name"}
                    agents={y.agents}
                    agentId={y.agentId}
                    onClose={() => setCreatingProject(null)}
                    onCreate={y.createProject}
                    onStart={async (item, agentId) => {
                      const started = await y.startFromItem(item, agentId);
                      setStartNote(started.chatError ? { projectId: started.project.id, message: started.chatError } : null);
                      return started;
                    }}
                    onOpenProject={(id) => y.setSelection({ kind: "project", id })}
                    onIntegrations={(service) => {
                      setCreatingProject(null);
                      setSetup({ kind: "integrations", service });
                    }}
                  />
                )}
                {project && reposWanted && (
                  <RepoPicker
                    open={addingRepos}
                    onClose={() => setAddingRepos(false)}
                    exclude={project.dirs}
                    onAdd={async (dirs) => y.putProject(await api.addProjectDirs(project.id, dirs))}
                  />
                )}
                {login}
              </Suspense>
              <AgentSetupDialog
                target={setup}
                onClose={() => setSetup(null)}
                agents={y.agents}
                defaultId={y.defaultAgentId}
                onLogin={setLoginFor}
                onSaved={(a) => y.setAgentId(a.id)}
              />
            </div>
          </AppContextMenu>
        </ChatActionsProvider>
      </TranscriptsContext.Provider>
    </TooltipProvider>
  );
}
