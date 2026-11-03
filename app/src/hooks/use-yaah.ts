// View state for the app. It holds no logic of its own: everything here is
// either fetched from a Rust command or applied from a Rust event.
import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, events, type AgentProfile, type Entry, type Project, type SessionInfo, type WorkItem } from "@/lib/api";
import { errorMessage } from "@/lib/narrow";

/** Sidebar order: archived projects sink to the bottom; otherwise newest first. */
export function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => Number(a.status === "archived") - Number(b.status === "archived") || b.createdAt - a.createdAt);
}

export type Yaah = ReturnType<typeof useYaah>;

export type Selection = { kind: "project"; id: string } | { kind: "chat"; id: string } | { kind: "components" } | null;

export function useYaah() {
  /** null until the first load; empty means first run (show the setup screen). */
  const [agentList, setAgentList] = useState<AgentProfile[] | null>(null);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  // The agent new chats use; starts as the default.
  const [pickedAgentId, setAgentId] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>({});
  const [entries, setEntries] = useState<Record<string, Entry[]>>({});
  const [selection, setSelection] = useState<Selection>(null);
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
      api.listSessions().then((list) => setSessions(Object.fromEntries(list.map((s) => [s.sessionId, s])))),
    ]).catch(setLoadError);

    const unlisten = [
      events.sessionEntry(({ sessionId, index, entry }) =>
        setEntries((prev) => {
          const list = [...(prev[sessionId] ?? [])];
          list[index] = entry;
          return { ...prev, [sessionId]: list };
        }),
      ),
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
  }, [refreshAgents, refreshProjects]);

  const agents = useMemo(() => agentList ?? [], [agentList]);
  // A picked agent that was removed falls back to the default.
  const agentId = (agents.some((a) => a.id === pickedAgentId) ? pickedAgentId : defaultAgentId) ?? agents[0]?.id ?? "";

  /** Replace one project in the list with the version Rust returned. */
  const putProject = useCallback((p: Project) => {
    setProjects((prev) => (prev.some((x) => x.id === p.id) ? prev.map((x) => (x.id === p.id ? p : x)) : [...prev, p]));
  }, []);

  const createProject = useCallback(
    async (name: string, dirs: string[]) => {
      const p = await api.createProject(name, dirs);
      putProject(p);
      setSelection({ kind: "project", id: p.id });
    },
    [putProject],
  );

  const deleteProject = useCallback(async (id: string) => {
    await api.deleteProject(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
    setSelection(null);
  }, []);

  const newChat = useCallback(
    async (projectId: string) => {
      const info = await api.newSession(projectId, agentId);
      setSessions((prev) => ({ ...prev, [info.sessionId]: info }));
      setSelection({ kind: "chat", id: info.sessionId });
      return info.sessionId;
    },
    [agentId],
  );

  /**
   * A project from a tracker item, or the one already following it. Opens the
   * new chat when Rust started one (else the project); the caller drafts its prompt.
   */
  const startFromItem = useCallback(
    async (item: WorkItem) => {
      const started = await api.startProjectFromItem(item.service, item.id, agentId);
      putProject(started.project);
      if (started.chatId) {
        const id = started.chatId;
        // Its "session-info" event may not have arrived yet.
        const info = (await api.listSessions()).find((s) => s.sessionId === id);
        if (info) setSessions((prev) => ({ ...prev, [id]: info }));
        setSelection({ kind: "chat", id });
      } else setSelection({ kind: "project", id: started.project.id });
      return started;
    },
    [agentId, putProject],
  );

  /** A chat outside any project, in `dir` or a fresh scratch folder. */
  const newQuickChat = useCallback(
    async (dir?: string) => {
      const info = await api.newQuickChat(agentId, dir);
      setSessions((prev) => ({ ...prev, [info.sessionId]: info }));
      setSelection({ kind: "chat", id: info.sessionId });
      return info.sessionId;
    },
    [agentId],
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

  /** Drops the chat; if it was open, its project (if any) opens instead. */
  const deleteChat = useCallback(async (chat: SessionInfo) => {
    const id = chat.sessionId;
    await api.deleteSession(id);
    setSessions(({ [id]: _, ...rest }) => rest);
    setEntries(({ [id]: _, ...rest }) => rest);
    setSelection((sel) => (sel?.kind === "chat" && sel.id === id ? (chat.projectId ? { kind: "project", id: chat.projectId } : null) : sel));
  }, []);

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

  // Chats restored from disk have no events yet: load their transcript when opened.
  const missingTranscript = selection?.kind === "chat" && !entries[selection.id] ? selection.id : null;
  useEffect(() => {
    if (!missingTranscript) return;
    const id = missingTranscript;
    api
      .getTranscript(id)
      .then((t) => setEntries((prev) => (prev[id] ? prev : { ...prev, [id]: t.entries })))
      .catch((e: unknown) =>
        setEntries((prev) =>
          prev[id] ? prev : { ...prev, [id]: [{ type: "error", message: `Couldn't load this chat: ${errorMessage(e)}`, loginAccount: null }] },
        ),
      );
  }, [missingTranscript]);

  const activeChat = selection?.kind === "chat" ? (sessions[selection.id] ?? null) : null;
  const activeProjectId = selection?.kind === "project" ? selection.id : (activeChat?.projectId ?? null);

  return {
    agents,
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
    activeChatEntries: activeChat ? (entries[activeChat.sessionId] ?? []) : [],
    activeProject: projects.find((p) => p.id === activeProjectId) ?? null,
    newChat,
    newQuickChat,
    newChatInFolder,
    moveChat,
    promoteChat,
    renameChat,
    deleteChat,
  };
}
