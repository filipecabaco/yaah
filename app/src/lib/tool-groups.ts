// Runs of tool calls drawn as one quiet row ("7 tool calls"), opened on a click. Only how the
// transcript is drawn: the entries themselves are as Rust sent them.
import { useSyncExternalStore } from "react";
import type { Entry } from "@/lib/api";
import { isFolded, type PermissionEntry } from "@/lib/permissions";

/** What the transcript draws: one entry, or a run of two or more tool calls as a group. */
export type Row = { kind: "entry"; index: number } | { kind: "group"; indices: number[] };

type Tool = Extract<Entry, { type: "tool" }>;

/** A tool call that may go in a group: not one with a diff to show (an edit stays in sight). */
const groupable = (e: Tool) => !e.content.some((c) => c.type === "diff");

/** Entries that draw nothing, so they don't break a run: a folded permission, an agent message with no text yet. */
const invisible = (e: Entry, folded: Map<string, PermissionEntry>) => isFolded(e, folded) || (e.type === "agent" && !e.text.trim());

/**
 * The rows for `entries[from..]`. Two or more tool calls in a row make a group; anything else
 * drawn between them (agent text, a user message, rendered UI, a permission card, a thought, an
 * edit's diff) ends the run. With `group` off every entry is its own row.
 */
export function transcriptRows(entries: readonly (Entry | undefined)[], from: number, folded: Map<string, PermissionEntry>, group = true): Row[] {
  const rows: Row[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= 2) rows.push({ kind: "group", indices: run });
    else for (const index of run) rows.push({ kind: "entry", index });
    run = [];
  };
  for (let i = from; i < entries.length; i++) {
    const e = entries[i];
    if (!e || invisible(e, folded)) continue;
    if (group && e.type === "tool" && groupable(e)) {
      run.push(i);
      continue;
    }
    flush();
    rows.push({ kind: "entry", index: i });
  }
  flush();
  return rows;
}

/** A tool call still going (its turn is running and it hasn't ended). */
export const isRunning = (e: Tool, inTurn: boolean) => inTurn && e.status !== "completed" && e.status !== "failed";

/** "Read, Edit, mcp__linear__get_issue": the first few distinct names in a group, for its row. */
export function groupPreview(tools: readonly Tool[], max = 3): string {
  const names: string[] = [];
  for (const t of tools) {
    const name = shortName(t);
    if (!names.includes(name)) names.push(name);
  }
  return names.length > max ? `${names.slice(0, max).join(", ")}, …` : names.join(", ");
}

/** A tool call's name for a preview: `Read`, `grep`, `get_issue (linear)`, or its kind. */
function shortName(t: Tool): string {
  const title = t.title.trim();
  const mcp = /^mcp__(.+?)__(.+)$/.exec(title) ?? /^mcp\.([^.]+)\.(.+)$/.exec(title);
  if (mcp) return `${mcp[2]} (${mcp[1].replace(/^claude_ai_/, "")})`;
  const word = /^[A-Za-z][\w-]*/.exec(title)?.[0];
  return word ?? t.kind ?? "tool";
}

// ── which groups are open ────────────────────────────────────────────────────
// Per chat and group (its first entry's index), for as long as the app runs.
const open = new Map<string, boolean>();
const openListeners = new Set<() => void>();
let openVersion = 0;

export function setGroupOpen(key: string, value: boolean) {
  open.set(key, value);
  openVersion++;
  openListeners.forEach((l) => l());
}

export function useGroupOpen(key: string): boolean {
  useSyncExternalStore(
    (l) => (openListeners.add(l), () => openListeners.delete(l)),
    () => openVersion,
  );
  return open.get(key) ?? false;
}

// ── the setting ──────────────────────────────────────────────────────────────
// Settings → Chat, "Group consecutive tool calls" (settings.json `groupToolCalls`, on by default).
let grouping = true;
const listeners = new Set<() => void>();

export function setGroupToolCalls(on: boolean) {
  grouping = on;
  listeners.forEach((l) => l());
}

export function useGroupToolCalls(): boolean {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => grouping,
  );
}
