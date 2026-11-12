// Opening terminal and diff panes: where (the focused pane, or a new split to its right),
// in which folder (what the focused pane works in) and for which project (the one that
// pane belongs to, so the sidebar lists the new pane there). Requests from deep in the
// tree (a tool card's "Open as pane") reach the app as a window event.
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Yaah } from "@/hooks/use-yaah";
import type { Project } from "@/lib/api";
import type { Selection } from "@/lib/layout";
import { focusPaneDom } from "@/lib/pane-focus";

export type TerminalTarget = { cwd?: string; id?: string; projectId?: string };
/** Where a pane opened from somewhere starts, and the project it belongs to (none: listed under "Open panes"). */
export type Origin = { cwd?: string; projectId?: string };
/** `here`: in the focused pane. `split`: a new pane to its right (or in place, when that pane is empty). */
export type Where = "here" | "split";

const OPEN_TERMINAL = "yaah:open-terminal";

/** Ask the app to open a terminal pane (App listens). */
export function openTerminalPane(target: TerminalTarget, where: Where = "split") {
  window.dispatchEvent(new CustomEvent(OPEN_TERMINAL, { detail: { target, where } }));
}

/** `dir` is one of the project's folders (its repos, its brief folder) or inside one. */
export function inProject(dir: string, p: Project): boolean {
  return [...p.dirs, p.contextDir].some((d) => {
    const root = d.replace(/\/+$/, "");
    return dir === root || dir.startsWith(`${root}/`);
  });
}

/**
 * Where a terminal or diff opened from a pane showing `c` starts, and which project it belongs to:
 * a project page's first repo (its brief folder when it has none); a project chat's own folder when
 * that is one of the project's, else the project's first repo; a quick chat's folder, no project;
 * a terminal's or diff's folder and project.
 */
export function originOf(c: Selection, y: Pick<Yaah, "sessions" | "projects">): Origin {
  const project = (id: string | null | undefined) => (id ? y.projects.find((p) => p.id === id) : undefined);
  if (c?.kind === "chat") {
    const s = y.sessions[c.id];
    const p = project(s?.projectId);
    if (!s || !p) return { cwd: s?.cwd };
    return { cwd: inProject(s.cwd, p) ? s.cwd : (p.dirs[0] ?? s.cwd), projectId: p.id };
  }
  if (c?.kind === "project") {
    const p = project(c.id);
    return p ? { cwd: p.dirs[0] ?? p.contextDir, projectId: p.id } : {};
  }
  if (c?.kind === "terminal" || c?.kind === "diff") return { cwd: c.cwd, projectId: project(c.projectId)?.id };
  return {};
}

export function useTerminals(y: Yaah) {
  // Read when an action runs, so the actions stay the same across renders (the memoised sidebar gets them).
  const latest = useRef(y);
  useEffect(() => {
    latest.current = y;
  });
  /** A terminal or diff pane: in the focused pane, or in a new split to its right. */
  const show = useCallback((content: Selection, where: Where) => {
    const { panes } = latest.current;
    const here = panes.focused.content;
    if (where === "here" || here == null || here.kind === "picker") {
      const id = panes.focusedId();
      panes.setPaneContent(id, content);
      focusPaneDom(id);
    } else {
      focusPaneDom(panes.split("row", content));
    }
  }, []);
  // The folder the agent was last worked in, for a pane that has no folder of its own (the home screen).
  const lastOrigin = useRef<Origin | null>(null);
  useEffect(() => {
    const here = y.panes.focused;
    if (here.content?.kind === "chat") lastOrigin.current = originOf(here.content, y);
  });
  // What each pane showed before it was switched to its terminal, and the terminal it was switched to:
  // the same pane swaps between them, so the layout stays as it is and the shell keeps running.
  const swapped = useRef(new Map<string, { chat: Selection; terminal?: Selection }>());
  /**
   * Switch this pane between the agent and a terminal in its folder, and back. The chat is kept
   * (draft, scroll, running turn) while the terminal shows, and the shell while the chat does.
   */
  const toggleTerminal = useCallback(() => {
    const { panes } = latest.current;
    const here = panes.focused;
    const id = here.id;
    // Panes that are gone take their stash with them (a new pane may reuse an id).
    for (const k of swapped.current.keys()) if (!panes.panes.some((p) => p.id === k)) swapped.current.delete(k);
    const stash = swapped.current.get(id);
    if (here.content?.kind === "terminal") {
      // Back: the terminal is kept (with its shell's id) for the next switch.
      const chatId = here.content.chatId;
      const back: Selection = chatId && latest.current.sessions[chatId] ? { kind: "chat", id: chatId } : (stash?.chat ?? null);
      if (!back) {
        // A terminal opened on its own has no chat to go back to in this pane: go to one beside it.
        const chat = panes.panes.find((p) => p.content?.kind === "chat");
        if (chat) {
          panes.focus(chat.id);
          focusPaneDom(chat.id);
        }
        return;
      }
      swapped.current.set(id, { chat: back, terminal: here.content });
      panes.setPaneContent(id, back);
      focusPaneDom(id);
      return;
    }
    const origin = originOf(here.content, latest.current);
    const target = origin.cwd ? origin : (lastOrigin.current ?? {});
    const kept = stash?.terminal?.kind === "terminal" && (!target.cwd || stash.terminal.cwd === target.cwd) ? stash.terminal : null;
    // The terminal belongs to the chat it replaced: the sidebar keeps showing that chat, and ⌘J goes back to it.
    const chatId = here.content?.kind === "chat" ? here.content.id : undefined;
    swapped.current.set(id, { chat: here.content, terminal: undefined });
    panes.setPaneContent(id, kept ? { ...kept, chatId } : { kind: "terminal", ...target, chatId });
    focusPaneDom(id);
  }, []);
  const focusedOrigin = useCallback(() => originOf(latest.current.panes.focused.content, latest.current), []);
  const open = useCallback((target: TerminalTarget, where: Where) => show({ kind: "terminal", ...target }, where), [show]);
  /** A diff pane of the repository `cwd` is in (none: the pane asks which folder). */
  const openDiff = useCallback((origin: Origin, where: Where = "split") => show({ kind: "diff", ...origin }, where), [show]);
  /** A terminal or diff of project `id`, in its first repo and listed under it (its page, its sidebar menu). */
  const openForProject = useCallback(
    (id: string, kind: "terminal" | "diff") => {
      const origin = originOf({ kind: "project", id }, latest.current);
      if (origin.projectId) show({ kind, ...origin }, "split");
    },
    [show],
  );

  useEffect(() => {
    const listener = (e: Event) => {
      const { target, where } = (e as CustomEvent<{ target: TerminalTarget; where: Where }>).detail;
      // A tool card's command, from the chat it ran in (clicking the card focused that pane): that chat's project.
      open({ ...target, projectId: target.projectId ?? focusedOrigin().projectId }, where);
    };
    window.addEventListener(OPEN_TERMINAL, listener);
    return () => window.removeEventListener(OPEN_TERMINAL, listener);
  }, [open, focusedOrigin]);

  return useMemo(
    () => ({
      /** A terminal in `cwd` (else the default folder: the last one used, or home); no project unless `projectId`. */
      open,
      openDiff,
      openForProject,
      /** ⌘T and "New terminal here": a new split to the right, in the focused pane's folder and project. */
      openHere: () => open(focusedOrigin(), "split"),
      /** ⌘J: from the agent to a terminal in its folder, and from the terminal back. */
      toggleTerminal,
      /** The focused pane's folder and project, if it has them. */
      focusedOrigin,
    }),
    [open, openDiff, openForProject, focusedOrigin, toggleTerminal],
  );
}
