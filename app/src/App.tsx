import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderGit2, MessageSquarePlus } from "lucide-react";
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
import { NewProjectDialog, Sidebar } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { useYaah } from "@/hooks/use-yaah";
import { api, canChat, type AgentProfile, type SessionInfo } from "@/lib/api";
import { onOpenSettings } from "@/lib/app-events";
import { formatKeys, SHORTCUTS } from "@/lib/shortcuts";

export default function App() {
  const y = useYaah();
  const [loginFor, setLoginFor] = useState<AgentProfile | null>(null);
  const [setup, setSetup] = useState<SettingsTarget | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [addingRepos, setAddingRepos] = useState(false);
  const [palette, setPalette] = useState<PalettePage | null>(null);
  const [help, setHelp] = useState(false);
  // Project whose delete confirmation the sidebar menu asked for.
  const [askDelete, setAskDelete] = useState<string | null>(null);
  const agent = y.agents.find((a) => a.id === y.agentId);
  const project = y.activeProject;
  const chat = y.activeChat;
  const clearAskDelete = useCallback(() => setAskDelete(null), []);
  const agents = y.agents;
  // Stable, so finished chat entries (which get it) don't re-render with the app.
  const loginById = useCallback((id: string) => setLoginFor(agents.find((a) => a.id === id) ?? null), [agents]);
  /** Start a chat if the agent can; otherwise log it in, or add one. */
  const withAgent = (start: () => Promise<void>) => {
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
    newProject: () => setCreatingProject(true),
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
              selection={y.selection}
              onSelect={y.setSelection}
              onNewProject={() => setCreatingProject(true)}
              onPalette={() => setPalette({ kind: "root" })}
              onNewChat={y.newChat}
              onProjectChange={y.putProject}
              onDeleteProject={(id) => {
                y.setSelection({ kind: "project", id });
                setAskDelete(id);
              }}
            />

            {y.selection?.kind === "components" ? (
              <ComponentsView />
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
                onNewChat={y.newChat}
                onLogin={setLoginFor}
                askDelete={askDelete === project.id}
                onAskDeleteSeen={clearAskDelete}
              />
            ) : (
              <main className="flex flex-1 items-center justify-center p-8">
                <div className="flex max-w-md flex-col items-center gap-4 text-center">
                  <p className="text-sm text-muted-foreground">
                    Start a quick chat for something small, or a project when the work spans several repos.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={() => withAgent(() => y.newQuickChat())}>
                      <MessageSquarePlus /> Quick chat <Kbd className="ml-1">{formatKeys(SHORTCUTS.newChat.keys)}</Kbd>
                    </Button>
                    <Button variant="outline" onClick={() => setCreatingProject(true)}>
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
              onNewProject={() => setCreatingProject(true)}
              onAddRepos={() => setAddingRepos(true)}
              onLogin={setLoginFor}
              onAddAgent={() => setSetup({ kind: "add" })}
              onManageAgents={() => setSetup({ kind: "manage", id: y.agentId || undefined })}
              onIntegrations={(service) => setSetup({ kind: "integrations", service })}
              onSettings={(tab) => setSetup({ kind: "settings", tab })}
              onHelp={() => setHelp(true)}
            />
            <ShortcutsDialog open={help} onClose={() => setHelp(false)} />
            <NewProjectDialog open={creatingProject} onClose={() => setCreatingProject(false)} onCreate={y.createProject} />
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
