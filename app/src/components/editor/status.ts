// How the editor pane shows a git change, as VS Code does: a letter, a colour, a word.
import type { ChangeStatus } from "@/lib/editor-api";

export const STATUS_COLOR: Record<ChangeStatus, string> = {
  M: "text-amber-600 dark:text-amber-400",
  T: "text-amber-600 dark:text-amber-400",
  A: "text-emerald-600 dark:text-emerald-400",
  U: "text-emerald-600 dark:text-emerald-400",
  C: "text-emerald-600 dark:text-emerald-400",
  R: "text-sky-600 dark:text-sky-400",
  D: "text-red-600 line-through dark:text-red-400",
  "!": "text-purple-600 dark:text-purple-400",
};

export const STATUS_WORD: Record<ChangeStatus, string> = {
  M: "Modified",
  T: "Type changed",
  A: "Added",
  U: "Untracked",
  C: "Copied",
  R: "Renamed",
  D: "Deleted",
  "!": "Conflict",
};

/** Which change wins when a folder holds several (shown on the folder). */
const RANK: ChangeStatus[] = ["!", "D", "M", "T", "R", "A", "C", "U"];
export const stronger = (a: ChangeStatus | undefined, b: ChangeStatus): ChangeStatus => (a && RANK.indexOf(a) <= RANK.indexOf(b) ? a : b);
