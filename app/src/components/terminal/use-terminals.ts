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
  // The pane and folder the agent was last worked in, so the terminal shortcut can go there and back.
  const lastAgent = useRef<{ pane: string; origin: Origin } | null>(null);
  useEffect(() => {
    const here = y.panes.focused;
    if (here.content?.kind === "chat") lastAgent.current = { pane: here.id, origin: originOf(here.content, y) };
  });
  /**
   * Switch between the agent and its terminal: from a chat, to a terminal in the folder it works in (the one
   * already open there, else a new split); from a terminal, back to the chat that was last worked in.
   */
  const toggleTerminal = useCallback(() => {
    const { panes } = latest.current;
    const go = (id: string) => {
      panes.focus(id);
      focusPaneDom(id);
    };
    const here = panes.focused;
    if (here.content?.kind === "terminal") {
      const chats = panes.panes.filter((p) => p.content?.kind === "chat");
      const back = chats.find((p) => p.id === lastAgent.current?.pane) ?? chats[0];
      if (back) go(back.id);
      return;
    }
    const origin = originOf(here.content, latest.current);
    const target = origin.cwd ? origin : (lastAgent.current?.origin ?? {});
    const open = panes.panes.find((p) => p.content?.kind === "terminal" && !!target.cwd && p.content.cwd === target.cwd);
    if (open) go(open.id);
    else show({ kind: "terminal", ...target }, "split");
  }, [show]);
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
