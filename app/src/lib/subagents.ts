// Sub-agents: a tool call that launches another agent (Claude Code's `Agent` / `Task`), and the
// calls that agent makes. Rust links them: a call made inside a sub-agent carries the launching
// call's id (`parentToolCallId`, from `_meta.claudeCode.parentToolUseId`). Chats saved before that,
// and agents that don't send it, have no link: the launching call is still drawn as a card, empty.
import { useSyncExternalStore } from "react";
import type { Entry } from "@/lib/api";
import { toolLabel } from "@/lib/ui-tool-label";

type Tool = Extract<Entry, { type: "tool" }>;

export type SubagentInfo = {
  /** What it is for: the call's `description`, else its type. */
  name: string;
  /** `subagent_type`, when it names one. */
  type: string | null;
  model: string | null;
  /** Launched with `run_in_background`: the launching call ends at once while the agent keeps working. */
  background: boolean;
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Whether `t` launches a sub-agent, and with what; null for any other tool call. */
export function subagentInfo(t: Tool): SubagentInfo | null {
  const input = t.rawInput;
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const type = str(i.subagent_type);
  if (!type && !(str(i.prompt) && str(i.description))) return null;
  return {
    name: str(i.description) ?? type ?? "Sub-agent",
    type,
    model: str(i.model),
    background: i.run_in_background === true,
  };
}

export type SubagentTree = {
  /** Launching call's entry index -> the entries drawn inside its card, in order (calls, and permission requests asking about them). */
  inside: Map<number, number[]>;
  /** Every entry index that is drawn inside a card, so the transcript skips it. */
  hidden: Set<number>;
};

/**
 * Which entries belong to which sub-agent. A call made inside a sub-agent that was itself launched
 * by a sub-agent goes under the outermost card. Entries before `from` (not on screen) are left alone.
 */
export function subagentTree(entries: readonly (Entry | undefined)[], from: number): SubagentTree {
  const index = new Map<string, number>();
  const parent = new Map<string, string>();
  entries.forEach((e, i) => {
    if (e?.type !== "tool") return;
    index.set(e.toolCallId, i);
    if (e.parentToolCallId) parent.set(e.toolCallId, e.parentToolCallId);
  });
  const root = (id: string): string | null => {
    let cur = parent.get(id);
    for (let guard = 0; cur && guard < 32; guard++) {
      const up = parent.get(cur);
      if (!up || !index.has(up)) return index.has(cur) ? cur : null;
      cur = up;
    }
    return null;
  };
  const inside = new Map<number, number[]>();
  const hidden = new Set<number>();
  entries.forEach((e, i) => {
    if (i < from || !e) return;
    const id = e.type === "tool" ? e.toolCallId : e.type === "permission" ? e.toolCallId : null;
    const top = id ? root(id) : null;
    const at = top == null ? undefined : index.get(top);
    if (at == null || at < from) return;
    hidden.add(i);
    inside.set(at, [...(inside.get(at) ?? []), i]);
  });
  return { inside, hidden };
}

export type AgentStatus = "running" | "background" | "done" | "failed";

/** Where a sub-agent stands. A background launch is "background" until its turn ends: nothing says when it finishes. */
export function agentStatus(t: Tool, info: SubagentInfo, inTurn: boolean): AgentStatus {
  if (t.status === "failed") return "failed";
  const ended = t.status === "completed";
  if (info.background && ended) return inTurn ? "background" : "done";
  return ended ? "done" : inTurn ? "running" : "done";
}

/** What it is doing now: the label of its latest call, e.g. "Reading src/a.ts". */
export function latestActivity(calls: readonly Tool[]): string | null {
  const last = calls[calls.length - 1];
  if (!last) return null;
  return toolLabel({ title: last.title, status: last.status, rawInput: last.rawInput })?.text ?? last.title;
}

/** The first line of its final answer, cut at `max` characters; the rest is behind the card's chevron. */
export function resultSummary(text: string, max = 140): string | null {
  const line = text
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
    // The adapter's receipt for a background launch ("Async agent launched successfully. (This tool result is
    // internal metadata…)") says nothing about what the agent did.
    .find((l) => l && !/^Async agent launched successfully/i.test(l));
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// ── how long each ran ────────────────────────────────────────────────────────
// From when this window first saw the call to when it saw it end; not saved with the chat.
const spans = new Map<string, { start: number; end?: number }>();
const spanListeners = new Set<() => void>();
let spanVersion = 0;

/** Note that `id` is `running` now (or not), and return its span so far in ms, or null if it was never seen running. */
export function trackSpan(id: string, running: boolean, now = Date.now()): number | null {
  let s = spans.get(id);
  if (running && !s) {
    s = { start: now };
    spans.set(id, s);
  } else if (!running && s && s.end == null) {
    s.end = now;
  }
  return s ? (s.end ?? now) - s.start : null;
}

/** Re-render each second while any is running. */
export function useSecondTick(active: boolean) {
  useSyncExternalStore(
    (l) => {
      if (!active) return () => {};
      spanListeners.add(l);
      const timer = setInterval(() => {
        spanVersion++;
        spanListeners.forEach((f) => f());
      }, 1000);
      return () => {
        spanListeners.delete(l);
        clearInterval(timer);
      };
    },
    () => (active ? spanVersion : 0),
  );
}

/** Sub-agent launches among `entries`, for the strip over the transcript. */
export function agentSummary(entries: readonly (Entry | undefined)[], inTurn: (i: number) => boolean) {
  const agents: { id: string; name: string; status: AgentStatus }[] = [];
  entries.forEach((e, i) => {
    if (e?.type !== "tool") return;
    const info = subagentInfo(e);
    if (info) agents.push({ id: e.toolCallId, name: info.name, status: agentStatus(e, info, inTurn(i)) });
  });
  return agents;
}

/** "3 agents running · 1 done", or null when none is running (nothing to watch). */
export function stripText(agents: readonly { status: AgentStatus }[]): string | null {
  const running = agents.filter((a) => a.status === "running" || a.status === "background").length;
  if (running === 0) return null;
  const done = agents.filter((a) => a.status === "done").length;
  const failed = agents.filter((a) => a.status === "failed").length;
  const parts = [`${running} ${running === 1 ? "agent" : "agents"} running`];
  if (done) parts.push(`${done} done`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

/** The element id of a sub-agent's card, for the strip to scroll to. */
export const subagentAnchor = (toolCallId: string) => `subagent-${toolCallId}`;
