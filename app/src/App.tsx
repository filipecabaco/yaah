import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderGit2, MessageSquarePlus } from "lucide-react";
import { Mark } from "@/components/brand/mark";
import { Chat } from "@/components/chat";
import { focusComposer } from "@/components/chat-context";
import { ErrorText } from "@/components/error-text";
import { CommandPalette, type PalettePage } from "@/components/command-palette";
import { ComponentsView } from "@/components/components-view";
import { AgentSetupDialog, FirstRunSetup, type SettingsTab, type SettingsTarget } from "@/components/agent-setup";
import { LoginDialog } from "@/components/login-dialog";
import { AppContextMenu, ChatActionsProvider } from "@/components/menus";
import { ProjectView } from "@/components/project-view";
import { RepoPicker } from "@/components/repo-picker";
import { ShortcutsDialog } from "@/components/shortcuts";
import { NewProjectDialog, Sidebar, type NewProjectMode } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { useYaah } from "@/hooks/use-yaah";
import { api, canChat, type AgentProfile, type SessionInfo } from "@/lib/api";
import { onOpenComponent, onOpenSettings } from "@/lib/app-events";
import { formatKeys, SHORTCUTS } from "@/lib/shortcuts";

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
  /** Start a chat if the agent can; otherwise log it in, or add one. */
  const withAgent = (start: () => Promise<unknown>) => {
    if (!agent) return setSetup({ kind: "add" });
    if (!canChat(agent)) return setLoginFor(agent);
    start().catch(console.error);
  };
  const openChat = (id: string) => y.setSelection({ kind: "chat", id });

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
  // A rendered UI's menu can open its component in the library.
  const select = y.setSelection;
  useEffect(
    () =>
      onOpenComponent((name) => {
        setShowComponent(name);
        select({ kind: "components" });
      }),
    [select],
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
    newChat: () => withAgent(() => (project ? y.newChat(project.id) : y.newQuickChat())),
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

  const login = (
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
        {login}
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={400}>
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
              onManageAgents={() => setSetup({ kind: "manage", id: y.agentId || undefined })}
              onSettings={() => setSetup({ kind: "settings" })}
              projects={y.orderedProjects}
              chatsByProject={y.chatsByProject}
              quickChats={y.quickChats}
              onNewQuickChat={() => withAgent(() => y.newQuickChat())}
              onNewChatInFolder={() => withAgent(() => y.newChatInFolder())}
              selection={y.selection}
              activeProjectId={project?.id ?? null}
              onSelect={y.setSelection}
              onNewProject={() => setCreatingProject("name")}
              onPalette={() => setPalette({ kind: "root" })}
              onNewChat={y.newChat}
              onProjectChange={y.putProject}
              onRenameProject={(id) => {
                y.setSelection({ kind: "project", id });
                setAskRename(id);
              }}
              onAddRepos={(id) => {
                y.setSelection({ kind: "project", id });
                setAddingRepos(true);
              }}
              onDeleteProject={(id) => {
                y.setSelection({ kind: "project", id });
                setAskDelete(id);
              }}
            />

            {y.selection?.kind === "components" ? (
              <ComponentsView initial={showComponent} onInitialSeen={clearShowComponent} />
            ) : chat ? (
              <Chat
                session={chat}
                entries={y.activeChatEntries}
                agents={y.agents}
                project={project}
                onOpenProject={(id) => y.setSelection({ kind: "project", id })}
                onLogin={loginById}
              />
            ) : project ? (
              <ProjectView
                project={project}
                chats={y.chatsByProject[project.id] ?? []}
                account={agent}
                onChange={y.putProject}
                onDelete={y.deleteProject}
                onOpenChat={openChat}
                onNewChat={(id) => {
                  setStartNote(null);
                  return y.newChat(id);
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
            ) : (
              <main className="flex flex-1 items-center justify-center p-8">
                <div className="flex max-w-md flex-col items-center gap-5 text-center">
                  <Mark assemble className="size-16 text-foreground" title="yaah" />
                  <p className="text-sm text-pretty text-muted-foreground">
                    Start a quick chat for something small, or a project when the work spans several repos.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={() => withAgent(() => y.newQuickChat())}>
                      <MessageSquarePlus /> Quick chat <Kbd className="ml-1">{formatKeys(SHORTCUTS.newChat.keys)}</Kbd>
                    </Button>
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
            <NewProjectDialog
              open={creatingProject != null}
              mode={creatingProject ?? "name"}
              onClose={() => setCreatingProject(null)}
              onCreate={y.createProject}
              onStart={async (item) => {
                const started = await y.startFromItem(item);
                setStartNote(started.chatError ? { projectId: started.project.id, message: started.chatError } : null);
                return started;
              }}
              onOpenProject={(id) => y.setSelection({ kind: "project", id })}
              onIntegrations={(service) => {
                setCreatingProject(null);
                setSetup({ kind: "integrations", service });
              }}
            />
            {project && (
              <RepoPicker
                open={addingRepos}
                onClose={() => setAddingRepos(false)}
                exclude={project.dirs}
                onAdd={async (dirs) => y.putProject(await api.addProjectDirs(project.id, dirs))}
              />
            )}
            {login}
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
    </TooltipProvider>
  );
}
