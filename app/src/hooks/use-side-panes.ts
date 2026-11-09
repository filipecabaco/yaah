// Side panes beside a chat: a diff, or one of its rendered UIs moved out of the transcript.
// The agent asks with `ui_open_pane` (ui_mcp.rs, the `ui-open-pane` event); the user with a UI
// entry's "Open in a side pane" or ⌘K (app-events.ts `openUiPane`). Either way the pane opens next
// to a pane showing that chat (layout.ts `openBeside`: one already showing it is reused). Also what
// the transcript reads to show a moved UI as a link (components/ui-panes-context.ts).
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { UiPanes } from "@/components/ui-panes-context";
import { inProject } from "@/components/terminal/use-terminals";
import type { Yaah } from "@/hooks/use-yaah";
import { events } from "@/lib/api";
import { onOpenUiPane } from "@/lib/app-events";
import { panesOf, shownUis, uiKey, type Layout, type Selection } from "@/lib/layout";
import { focusPaneDom } from "@/lib/pane-focus";

/** The interface size over its default (the root font size over 16px): pane minimums grow with it. */
const interfaceScale = () => parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1;

/** The main area's size in pixels (none in a test without layout: every pane fits then). */
function gridSize(): { w: number; h: number } | undefined {
  const r = document.getElementById("main")?.getBoundingClientRect();
  return r && r.width > 0 && r.height > 0 ? { w: r.width, h: r.height } : undefined;
}

/** The pane showing chat `sessionId` (the focused one if several do), if any. */
export function chatPane(layout: Layout, sessionId: string): string | undefined {
  const showing = panesOf(layout.root).filter((p) => p.content?.kind === "chat" && p.content.id === sessionId);
  return (showing.find((p) => p.id === layout.focused) ?? showing[0])?.id;
}

export function useSidePanes(y: Pick<Yaah, "panes" | "sessions" | "projects">) {
  // Read when a request comes, so the listeners stay put.
  const latest = useRef(y);
  useEffect(() => {
    latest.current = y;
  });

  /**
   * Open `content` beside chat `sessionId`'s pane (or `from`), `down` or to the right. A diff of one of
   * the chat's project's folders is listed under that project, as one opened from the project is.
   */
  const open = useCallback((sessionId: string, content: Selection, direction: "right" | "down", from?: string, focus = false) => {
    const { panes, sessions, projects } = latest.current;
    if (content?.kind === "diff" && content.cwd && !content.projectId) {
      const project = projects.find((p) => p.id === sessions[sessionId]?.projectId);
      if (project && inProject(content.cwd, project)) content = { ...content, projectId: project.id };
    }
    const start = from && panes.panes.some((p) => p.id === from) ? from : (chatPane(panes.layout, sessionId) ?? panes.focusedId());
    const id = panes.openBeside(start, content, direction === "down" ? "column" : "row", { size: gridSize(), scale: interfaceScale(), focus });
    if (!id) console.warn("no room for another pane", content);
    else if (focus) focusPaneDom(id);
    return id;
  }, []);

  useEffect(() => {
    const unlisten = events.uiOpenPane((e) => void open(e.sessionId, e.content, e.direction));
    return () => void unlisten.then((f) => f());
  }, [open]);
  useEffect(() => onOpenUiPane(({ chat, index, pane }) => void open(chat, { kind: "ui", chat, index }, "right", pane, true)), [open]);

  // The transcript's view of it: the same object while the same UIs are in the same panes, so a
  // layout change elsewhere (a divider, another pane's content) doesn't re-render every UI entry.
  const shownKey = [...shownUis(y.panes.layout)].map(([ui, pane]) => `${ui}\t${pane}`).join("\n");
  const lookup = useMemo(() => new Map(shownKey ? shownKey.split("\n").map((line) => line.split("\t") as [string, string]) : []), [shownKey]);
  const { focus: focusPane, close } = y.panes;
  return useMemo<UiPanes>(
    () => ({
      paneOf: (chat, index) => lookup.get(uiKey(chat, index)),
      focus: (pane) => {
        focusPane(pane);
        focusPaneDom(pane);
      },
      close: (pane) => {
        if (!close(pane)) latest.current.panes.setPaneContent(pane, null);
        focusPaneDom(latest.current.panes.focusedId());
      },
    }),
    [lookup, focusPane, close],
  );
}
