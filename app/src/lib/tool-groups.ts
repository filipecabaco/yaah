// Runs of tool calls drawn as one quiet row ("7 tool calls"), opened on a click. Only how the
// transcript is drawn: the entries themselves are as Rust sent them.
import { useSyncExternalStore } from "react";
import type { Entry } from "@/lib/api";
import { shellCommand } from "@/lib/ui-tool-label";
import { isFolded, type PermissionEntry } from "@/lib/permissions";
import { subagentInfo, subagentTree } from "@/lib/subagents";
import { pendingBatch } from "@/lib/permission-batch";

/** What the transcript draws: one entry, or a run of two or more tool calls as a group. */
export type Row =
  | { kind: "entry"; index: number }
  | { kind: "group"; indices: number[] }
  /** A call that launched a sub-agent, with the entries drawn inside its card (its own calls, and requests about them). */
  | { kind: "agent"; index: number; inside: number[]; asking?: number }
  /** Two or more permission requests waiting: one card at the first's place, listing `members` (entry indices). */
  | { kind: "batch"; index: number; members: number[] };

type Tool = Extract<Entry, { type: "tool" }>;

/** A tool call that may go in a group: not one with a diff to show (an edit stays in sight). */
const groupable = (e: Tool) => !e.content.some((c) => c.type === "diff");

/** Entries that draw nothing, so they don't break a run: a folded permission, an agent message with no text yet. */
const invisible = (e: Entry, folded: Map<string, PermissionEntry>) => isFolded(e, folded) || (e.type === "agent" && !e.text.trim());

/**
 * The shell calls whose permission request is still waiting, by tool call id. The request's card
 * shows the whole command already, so the tool row beside it would say the same thing twice.
 * Never a call with a diff (the card doesn't show it) or one that isn't a shell command.
 */
function askedCommands(entries: readonly (Entry | undefined)[]): Set<string> {
  const waiting = new Set<string>();
  for (const e of entries) if (e?.type === "permission" && e.toolCallId && e.chosen == null) waiting.add(e.toolCallId);
  const ids = new Set<string>();
  if (waiting.size === 0) return ids;
  for (const e of entries) if (e?.type === "tool" && waiting.has(e.toolCallId) && groupable(e) && shellCommand(e.rawInput)) ids.add(e.toolCallId);
  return ids;
}

/**
 * The rows for `entries[from..]`. Two or more tool calls in a row make a group; anything else
 * drawn between them (agent text, a user message, rendered UI, a permission card, a thought, an
 * edit's diff) ends the run. With `group` off every entry is its own row.
 */
export function transcriptRows(entries: readonly (Entry | undefined)[], from: number, folded: Map<string, PermissionEntry>, group = true): Row[] {
  const rows: Row[] = [];
  const asked = askedCommands(entries);
  const { inside, hidden } = subagentTree(entries, from);
  // Two or more waiting requests (a sub-agent's too) are one card; a lone one keeps its own.
  const batch = pendingBatch(entries);
  const members = new Set(batch?.items.map((m) => m.index));
  let batched = false;
  let run: number[] = [];
  const flush = () => {
    if (run.length >= 2) rows.push({ kind: "group", indices: run });
    else for (const index of run) rows.push({ kind: "entry", index });
    run = [];
  };
  for (let i = from; i < entries.length; i++) {
    const e = entries[i];
    if (!e || invisible(e, folded) || (e.type === "tool" && asked.has(e.toolCallId))) continue;
    if (members.has(i)) {
      if (!batched) {
        flush();
        rows.push({ kind: "batch", index: i, members: batch!.items.map((m) => m.index) });
        batched = true;
      }
      continue;
    }
    if (hidden.has(i)) continue;
    if (e.type === "tool" && subagentInfo(e)) {
      flush();
      const all = inside.get(i) ?? [];
      const asking = all.filter((j) => members.has(j));
      // The card for requests waiting inside a sub-agent sits where that sub-agent's card does.
      if (asking.length > 0 && !batched) {
        rows.push({ kind: "batch", index: asking[0], members: batch!.items.map((m) => m.index) });
        batched = true;
      }
      const calls = all.filter((j) => {
        const c = entries[j];
        return c && !members.has(j) && !invisible(c, folded) && !(c.type === "tool" && asked.has(c.toolCallId));
      });
      rows.push(asking.length > 0 ? { kind: "agent", index: i, inside: calls, asking: asking.length } : { kind: "agent", index: i, inside: calls });
      continue;
    }
    if (group && e.type === "tool" && groupable(e)) {
      run.push(i);
      continue;
    }
    flush();
    rows.push({ kind: "entry", index: i });
  }
  flush();
  // Every waiting request is listed, even when all of them are above what is drawn.
  if (batch && !batched) rows.push({ kind: "batch", index: batch.items[0].index, members: batch.items.map((m) => m.index) });
  return rows;
}

/** A tool call still going (its turn is running and it hasn't ended). */
export const isRunning = (e: Tool, inTurn: boolean) => inTurn && e.status !== "completed" && e.status !== "failed";

/** "Read ×3, Edit, command ×2, …": the first few distinct names in a group, with how many of each, for its row. */
export function groupPreview(tools: readonly Tool[], max = 3): string {
  const counts = new Map<string, number>();
  for (const t of tools) {
    const name = shortName(t);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  return names.length > max ? `${names.slice(0, max).join(", ")}, …` : names.join(", ");
}

/**
 * A shell call: kind "execute", an input with a `command`, a tool named bash/sh/zsh, or a title
 * that is itself a command line (`cd x && …`, `a; b`, `a | b`), for agents that send no input.
 */
export function looksLikeShell(t: Tool, title = t.title.trim()): boolean {
  if (t.kind === "execute" || shellCommand(t.rawInput)) return true;
  if (/^(bash|sh|zsh|shell)$/i.test(title)) return true;
  return /^cd\s/.test(title) || /&&|\|\||;|\s\|\s/.test(title);
}

/** A tool call's name for a preview: `Read`, `grep`, `get_issue (linear)`, `command` for a shell call, or its kind. */
function shortName(t: Tool): string {
  const title = t.title.trim();
  const mcp = /^mcp__(.+?)__(.+)$/.exec(title) ?? /^mcp\.([^.]+)\.(.+)$/.exec(title);
  if (mcp) return `${mcp[2]} (${mcp[1].replace(/^claude_ai_/, "")})`;
  if (looksLikeShell(t, title)) return "command";
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
