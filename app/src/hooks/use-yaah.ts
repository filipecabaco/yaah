// View state for the app. It holds no logic of its own: everything here is
// either fetched from a Rust command or applied from a Rust event.
import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, events, type AgentProfile, type NewProjectOptions, type Project, type SessionInfo, type WorkItem } from "@/lib/api";
import { TranscriptStore } from "@/lib/transcripts";
import type { Selection } from "@/lib/layout";
import { useLayout } from "@/hooks/use-layout";

/** Sidebar order: archived projects sink to the bottom; otherwise newest first. */
export function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => Number(a.status === "archived") - Number(b.status === "archived") || b.createdAt - a.createdAt);
}

export type Yaah = ReturnType<typeof useYaah>;

export type { Selection };

export function useYaah() {
  /** null until the first load; empty means first run (show the setup screen). */
  const [agentList, setAgentList] = useState<AgentProfile[] | null>(null);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  // The agent new chats use; starts as the default.
  const [pickedAgentId, setAgentId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>({});
  // Transcripts live outside React state: a chunk re-renders only its chat (use-transcript.ts).
  const [transcripts] = useState(() => new TranscriptStore((id, from, limit) => api.getEntries(id, from, limit)));
  // The split panes and the sidebar. What the focused pane shows is "the selection" everything else acts on.
  const panes = useLayout();
  const selection = panes.focused.content;
  const setSelection = panes.select;
  const { openIn, focusedId, mapContents } = panes;
  /** False until the chats have loaded once (a restored pane may name one). */
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  /** Why the first load (agents, projects, chats) failed, if it did. */
  const [loadError, setLoadError] = useState<unknown>(null);

  const refreshAgents = useCallback(
    () =>
      api.listAgents().then(({ profiles, defaultId }) => {
        setAgentList(profiles);
        setDefaultAgentId(defaultId);
      }),
    [],
  );
  const refreshProjects = useCallback(() => api.listProjects().then(setProjects), []);

  useEffect(() => {
    Promise.all([
      refreshAgents(),
      refreshProjects(),
      api.listSessions().then((list) => {
        setSessions(Object.fromEntries(list.map((s) => [s.sessionId, s])));
        setSessionsLoaded(true);
      }),
    ]).catch(setLoadError);

    const unlisten = [
      events.sessionEntry((e) => transcripts.entry(e)),
      events.sessionAppend((e) => transcripts.append(e)),
      events.sessionDraft((e) => transcripts.draft(e)),
      events.sessionInfo((info) => setSessions((prev) => ({ ...prev, [info.sessionId]: info }))),
      events.accountsChanged(() => {
        refreshAgents().catch((e: unknown) => console.error("could not reload agents", e));
      }),
      // Started from, refreshed from or unlinked from a tracker item.
      events.projectsChanged(() => {
        refreshProjects().catch((e: unknown) => console.error("could not reload projects", e));
      }),
    ];
    return () => unlisten.forEach((p) => void p.then((f) => f()));
  }, [refreshAgents, refreshProjects, transcripts]);

  const agents = useMemo(() => agentList ?? [], [agentList]);
  // A picked agent that was removed falls back to the default.
  const agentId = (agents.some((a) => a.id === pickedAgentId) ? pickedAgentId : defaultAgentId) ?? agents[0]?.id ?? "";

  /** Replace one project in the list with the version Rust returned. */
  const putProject = useCallback((p: Project) => {
    setProjects((prev) => (prev.some((x) => x.id === p.id) ? prev.map((x) => (x.id === p.id ? p : x)) : [...prev, p]));
  }, []);

  const createProject = useCallback(
    async (name: string, dirs: string[], options?: NewProjectOptions) => {
      // It opens in the pane the user started from, even if they moved on meanwhile.
      const pane = focusedId();
      const p = await api.createProject(name, dirs, options);
      putProject(p);
      openIn(pane, { kind: "project", id: p.id });
    },
    [putProject, focusedId, openIn],
  );

  // Every pane showing it goes home.
  const deleteProject = useCallback(
    async (id: string) => {
      await api.deleteProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
      mapContents((c) => (c?.kind === "project" && c.id === id ? null : c));
    },
    [mapContents],
  );

  /** The agent a project's new chats start with: its own while it still exists, else the sidebar's. */
  const agentFor = useCallback(
    (projectId: string | null | undefined) => {
      const own = projects.find((p) => p.id === projectId)?.agentId;
      return own && agents.some((a) => a.id === own) ? own : agentId;
    },
    [projects, agents, agentId],
  );

  /** A chat in a project, with `agent` when the user picked one, else the project's; `extraDirs` join the project. */
  const newChat = useCallback(
    async (projectId: string, agent?: string, extraDirs?: string[]) => {
      const pane = focusedId();
      const info = await api.newSession(projectId, agent || agentFor(projectId), extraDirs);
      transcripts.created(info.sessionId);
      setSessions((prev) => ({ ...prev, [info.sessionId]: info }));
      openIn(pane, { kind: "chat", id: info.sessionId });
      return info.sessionId;
    },
    [agentFor, transcripts, focusedId, openIn],
  );

  /**
   * A project from a tracker item, or the one already following it. Opens the
   * new chat when Rust started one (else the project); the caller drafts its prompt.
   */
  const startFromItem = useCallback(
    async (item: WorkItem, agent?: string) => {
      const pane = focusedId();
      const started = await api.startProjectFromItem(item.service, item.id, agent || agentId);
      putProject(started.project);
      if (started.chatId) {
        const id = started.chatId;
        // Its "session-info" event may not have arrived yet.
        const info = (await api.listSessions()).find((s) => s.sessionId === id);
        if (info) setSessions((prev) => ({ ...prev, [id]: info }));
        openIn(pane, { kind: "chat", id });
      } else openIn(pane, { kind: "project", id: started.project.id });
      return started;
    },
    [agentId, putProject, focusedId, openIn],
  );

  /** A chat outside any project, in `dir` or a fresh scratch folder, with `agent` or the sidebar's, and `extraDirs` (repos) as its own. */
  const newQuickChat = useCallback(
    async (dir?: string, agent?: string, extraDirs?: string[]) => {
      const pane = focusedId();
      const info = await api.newQuickChat(agent || agentId, dir, extraDirs);
      transcripts.created(info.sessionId);
      setSessions((prev) => ({ ...prev, [info.sessionId]: info }));
      openIn(pane, { kind: "chat", id: info.sessionId });
      return info.sessionId;
    },
    [agentId, transcripts, focusedId, openIn],
  );

  /** A quick chat in a folder the user picks (e.g. one holding the data to analyse). Nothing if they cancel. */
  const newChatInFolder = useCallback(async () => {
    const dir = await open({ directory: true, title: "Folder for the new chat" });
    if (typeof dir === "string") await newQuickChat(dir);
  }, [newQuickChat]);

  /** File a chat under a project, or back out of one (null). */
  const moveChat = useCallback(async (id: string, projectId: string | null) => {
    const info = await api.setChatProject(id, projectId);
    setSessions((prev) => ({ ...prev, [id]: info }));
  }, []);

  /** Turn a quick chat into a project made from its folder. */
  const promoteChat = useCallback(
    async (id: string, name: string) => {
      const [project, info] = await api.promoteChat(id, name);
      putProject(project);
      setSessions((prev) => ({ ...prev, [id]: info }));
    },
    [putProject],
  );

  const renameChat = useCallback(async (id: string, title: string) => {
    const info = await api.renameSession(id, title);
    setSessions((prev) => ({ ...prev, [id]: info }));
  }, []);

  /** Drops the chat; every pane that showed it shows its project (if any) instead. */
  const deleteChat = useCallback(
    async (chat: SessionInfo) => {
      const id = chat.sessionId;
      await api.deleteSession(id);
      setSessions(({ [id]: _, ...rest }) => rest);
      transcripts.remove(id);
      mapContents((c) => (c?.kind === "chat" && c.id === id ? (chat.projectId ? { kind: "project", id: chat.projectId } : null) : c));
    },
    [transcripts, mapContents],
  );

  const orderedProjects = useMemo(() => sortProjects(projects), [projects]);

  // Newest first everywhere chats are listed.
  const newestFirst = useMemo(() => Object.values(sessions).sort((a, b) => b.createdAt - a.createdAt), [sessions]);

  const chatsByProject = useMemo(() => {
    const map: Record<string, SessionInfo[]> = {};
    for (const s of newestFirst) if (s.projectId) (map[s.projectId] ??= []).push(s);
    return map;
  }, [newestFirst]);

  /** Chats outside any project (quick analysis, side things). */
  const quickChats = useMemo(() => newestFirst.filter((s) => !s.projectId), [newestFirst]);

  /** Every chat in sidebar order, for previous/next chat. */
  const chatOrder = useMemo(
    () => [...quickChats, ...orderedProjects.flatMap((p) => chatsByProject[p.id] ?? [])],
    [quickChats, orderedProjects, chatsByProject],
  );

  const activeChat = selection?.kind === "chat" ? (sessions[selection.id] ?? null) : null;
  const activeProjectId = selection?.kind === "project" ? selection.id : (activeChat?.projectId ?? null);

  return {
    agents,
    /** Every chat by id (a pane shows any of them). */
    sessions,
    sessionsLoaded,
    /** The split panes and the sidebar (use-layout.ts). */
    panes,
    /** False until agents have loaded once. */
    agentsLoaded: agentList !== null,
    loadError,
    agentId,
    setAgentId,
    defaultAgentId,
    refreshAgents,
    projects,
    orderedProjects,
    putProject,
    createProject,
    startFromItem,
    deleteProject,
    chatsByProject,
    quickChats,
    chatOrder,
    selection,
    setSelection,
    activeChat,
    /** Every chat's transcript; a chat reads its own with `useTranscript`. */
    transcripts,
    activeProject: projects.find((p) => p.id === activeProjectId) ?? null,
    agentFor,
    newChat,
    newQuickChat,
    newChatInFolder,
    moveChat,
    promoteChat,
    renameChat,
    deleteChat,
  };
}
