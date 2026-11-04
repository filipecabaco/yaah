// Opening terminal panes: where (the focused pane, or a new split to its right) and
// in which folder (what the focused pane works in). Requests from deep in the tree
// (a tool card's "Open as pane") reach the app as a window event.
import { useCallback, useEffect } from "react";
import type { Yaah } from "@/hooks/use-yaah";
import type { Selection } from "@/lib/layout";
import { focusPaneDom } from "@/lib/pane-focus";

export type TerminalTarget = { cwd?: string; id?: string };
/** `here`: in the focused pane. `split`: a new pane to its right (or in place, when that pane is empty). */
export type Where = "here" | "split";

const OPEN_TERMINAL = "yaah:open-terminal";

/** Ask the app to open a terminal pane (App listens). */
export function openTerminalPane(target: TerminalTarget, where: Where = "split") {
  window.dispatchEvent(new CustomEvent(OPEN_TERMINAL, { detail: { target, where } }));
}

/** The folder a pane works in: a chat's, a project's first repo, a terminal's. */
export function folderOf(c: Selection, y: Pick<Yaah, "sessions" | "projects">): string | undefined {
  if (c?.kind === "chat") return y.sessions[c.id]?.cwd;
  if (c?.kind === "project") {
    const p = y.projects.find((x) => x.id === c.id);
    return p?.dirs[0] ?? p?.contextDir;
  }
  if (c?.kind === "terminal" || c?.kind === "diff") return c.cwd;
  return undefined;
}

export function useTerminals(y: Yaah) {
  const { panes } = y;
  /** A terminal or diff pane: in the focused pane, or in a new split to its right. */
  const show = useCallback(
    (content: Selection, where: Where) => {
      const here = panes.focused.content;
      if (where === "here" || here == null || here.kind === "picker") {
        const id = panes.focusedId();
        panes.setPaneContent(id, content);
        focusPaneDom(id);
      } else {
        focusPaneDom(panes.split("row", content));
      }
    },
    [panes],
  );
  const open = useCallback((target: TerminalTarget, where: Where) => show({ kind: "terminal", ...target }, where), [show]);
  /** A diff pane of the repository `cwd` is in (none: the pane asks which folder). */
  const openDiff = useCallback((cwd: string | undefined, where: Where = "split") => show({ kind: "diff", cwd }, where), [show]);

  useEffect(() => {
    const listener = (e: Event) => {
      const { target, where } = (e as CustomEvent<{ target: TerminalTarget; where: Where }>).detail;
      open(target, where);
    };
    window.addEventListener(OPEN_TERMINAL, listener);
    return () => window.removeEventListener(OPEN_TERMINAL, listener);
  }, [open]);

  return {
    /** A terminal in `cwd` (else the default folder: the last one used, or home). */
    open,
    openDiff,
    /** ⌘T and "New terminal here": a new split to the right, in the focused pane's folder. */
    openHere: () => open({ cwd: folderOf(panes.focused.content, y) }, "split"),
    /** The focused pane's folder, if it has one. */
    focusedFolder: () => folderOf(panes.focused.content, y),
  };
}
