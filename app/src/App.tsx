import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FolderGit2, MessageSquarePlus } from "lucide-react";
import { AgentMenu } from "@/components/agent-choice";
import { Mark } from "@/components/brand/mark";
import { Chat } from "@/components/chat";
import { focusComposer } from "@/components/chat-context";
import { ErrorText } from "@/components/error-text";
import { CommandPalette, type PalettePage } from "@/components/command-palette";
import { AgentSetupDialog, FirstRunSetup, type SettingsTab, type SettingsTarget } from "@/components/agent-setup";
import { AppContextMenu, ChatActionsProvider } from "@/components/menus";
import { ShortcutsDialog } from "@/components/shortcuts";
import type { NewProjectMode } from "@/components/new-project-dialog";
import { preloadSettings } from "@/components/settings/tab-code";
import { Sidebar } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { useYaah, type Selection } from "@/hooks/use-yaah";
import { TranscriptsContext } from "@/hooks/use-transcript";
import { api, canChat, type AgentProfile, type SessionInfo } from "@/lib/api";
import { onOpenAgentSwitch, onOpenComponent, onOpenSettings } from "@/lib/app-events";
import { formatKeys, SHORTCUTS } from "@/lib/shortcuts";
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
  const [loginFor, setLoginFor] = useState<AgentProfile | null>(null);
  const [setup, setSetup] = useState<SettingsTarget | null>(null);
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
  const loginById = useCallback((id: string) => setLoginFor(agents.find((a) => a.id === id) ?? null), [agents]);
  /** Start a chat if its agent (`id`, else the sidebar's) can; otherwise log it in, or add one. */
  const withAgent = useCallback(
    (start: () => Promise<unknown>, id?: string) => {
      const a = id ? agents.find((x) => x.id === id) : agent;
      if (!a) return setSetup({ kind: "add" });
      if (!canChat(a)) return setLoginFor(a);
      start().catch(console.error);
    },
    [agent, agents],
  );
  const select = y.setSelection;
  const openChat = (id: string) => select({ kind: "chat", id });
  // The Component library takes the main area; closing it goes back to what was open before (a chat, a project, or home).
  const selection = y.selection;
  const current = useRef<Selection>(selection);
  const beforeLibrary = useRef<Selection>(null);
  // However the library opens (sidebar, palette, a chat's menu), remember the view it replaced.
  useEffect(() => {
    if (selection?.kind === "components" && current.current?.kind !== "components") beforeLibrary.current = current.current;
    current.current = selection;
  }, [selection]);
  const openLibrary = useCallback(() => select({ kind: "components" }), [select]);
  const closeLibrary = useCallback(() => select(beforeLibrary.current), [select]);
  /** The sidebar's selection; its "Component library" entry toggles the library. */
  const selectFromSidebar = useCallback(
    (s: Selection) => {
      if (s?.kind !== "components") return select(s);
      if (current.current?.kind === "components") closeLibrary();
      else openLibrary();
    },
    [select, openLibrary, closeLibrary],
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
    jumpChat: (n) => {
      const target = project && y.chatsByProject[project.id]?.[(n ?? 1) - 1];
      if (target) openChat(target.sessionId);
    },
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

  // Starting: the same sliding mark index.html shows before any script ran, until the agents are in.
  if (!y.agentsLoaded && !y.loadError) {
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
                {...sidebar}
              />

              {y.selection?.kind === "components" ? (
                <Suspense fallback={<main className="flex-1" />}>
                  <ComponentsView initial={showComponent} onInitialSeen={clearShowComponent} onClose={closeLibrary} />
                </Suspense>
              ) : chat ? (
                <Chat
                  session={chat}
                  agents={y.agents}
                  project={project}
                  onOpenProject={(id) => y.setSelection({ kind: "project", id })}
                  onLogin={loginById}
                />
              ) : project ? (
                <Suspense fallback={<main className="flex-1" />}>
                  <ProjectView
                    project={project}
                    chats={y.chatsByProject[project.id] ?? []}
                    agents={y.agents}
                    account={y.agents.find((a) => a.id === y.agentFor(project.id))}
                    onChange={y.putProject}
                    onDelete={y.deleteProject}
                    onOpenChat={openChat}
                    onNewChat={(id, agentId) => {
                      setStartNote(null);
                      return y.newChat(id, agentId);
                    }}
                    onLogin={setLoginFor}
                    askDelete={askDelete === project.id}
                    onAskDeleteSeen={clearAskDelete}
                    askRename={askRename === project.id}
                    onAskRenameSeen={clearAskRename}
                    notice={
                      startNote?.projectId === project.id
                        ? `Started from ${project.link?.id ?? "the issue"}, but its chat didn't open: ${startNote.message}`
                        : undefined
                    }
                  />
                </Suspense>
              ) : (
                <main className="flex flex-1 items-center justify-center p-8">
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
                    </div>
                  </div>
                </main>
              )}

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
