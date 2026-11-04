// The ⌘K palette's terminal actions: a new terminal pane (in the default folder, or
// the focused pane's, belonging to its project), and "Open in terminal" (the user's own terminal app).
import type { ReactNode } from "react";
import { ExternalLink, GitCompare } from "lucide-react";
import { compactPath } from "@/lib/format";
import type { ShortcutId } from "@/lib/shortcuts";
import { openInTerminalApp } from "@/lib/terminal-api";
import type { useTerminals } from "./use-terminals";

export type Terminals = ReturnType<typeof useTerminals>;

type Action = { id: string; icon?: ReactNode; label: string; detail?: string; shortcut?: ShortcutId; onSelect: () => void };

export function terminalActions(t: Terminals, icon: ReactNode, close: (then?: () => void) => void): Action[] {
  const origin = t.focusedOrigin();
  const folder = origin.cwd;
  const actions: Action[] = [
    { id: "new-terminal", icon, label: "New terminal", detail: "in the default folder", onSelect: () => close(() => t.open({}, "split")) },
  ];
  actions.push({
    id: "open-diff",
    icon: <GitCompare />,
    label: "Open diff…",
    detail: "changes of a git repository",
    onSelect: () => close(() => t.openDiff({})),
  });
  if (folder) {
    actions.push(
      {
        id: "diff-here",
        icon: <GitCompare />,
        label: "Diff of this folder",
        detail: compactPath(folder),
        onSelect: () => close(() => t.openDiff(origin)),
      },
      {
        id: "new-terminal-here",
        icon,
        label: "New terminal here",
        detail: compactPath(folder),
        shortcut: "newTerminal",
        onSelect: () => close(t.openHere),
      },
      {
        id: "open-in-terminal",
        icon: <ExternalLink />,
        label: "Open in terminal",
        detail: `${compactPath(folder)} · your terminal app`,
        onSelect: () => close(() => openInTerminalApp(folder)),
      },
    );
  }
  return actions;
}
