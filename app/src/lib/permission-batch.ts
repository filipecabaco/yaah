// Permission batching: two or more requests waiting in a chat (the main agent's, and those of
// sub-agents, possibly several at once) are drawn as one card, so the user answers them in one go
// instead of being interrupted by each. Which requests wait, and who asked, is decided here; the
// answers still go one by one through api.respondPermission.
import type { Entry } from "@/lib/api";
import { subagentInfo } from "@/lib/subagents";

export type PermissionBatchItem = {
  /** The request's entry index (what respondPermission addresses). */
  index: number;
  /** The sub-agent that asked: its launching call's id and name; null for the main agent. */
  agentId: string | null;
  agent: string | null;
};

export type PermissionBatch = {
  /** Every request still waiting, in transcript order. */
  items: PermissionBatchItem[];
  /** Whether the requests come from more than one asker (the main agent counts as one). */
  mixed: boolean;
};

/** The pending requests when there are two or more, else null (a lone request is drawn as a single card). */
export function pendingBatch(entries: readonly (Entry | undefined)[]): PermissionBatch | null {
  const all = pendingRequests(entries);
  return all && all.items.length >= 2 ? all : null;
}

/** Every pending request, in order, with who asked; null when none waits. */
export function pendingRequests(entries: readonly (Entry | undefined)[]): PermissionBatch | null {
  const launches = new Map<string, Entry & { type: "tool" }>();
  const parent = new Map<string, string>();
  for (const e of entries) {
    if (e?.type !== "tool") continue;
    launches.set(e.toolCallId, e);
    if (e.parentToolCallId) parent.set(e.toolCallId, e.parentToolCallId);
  }
  // The outermost launching call above `id`, as the sub-agent cards nest them.
  const root = (id: string): string | null => {
    let top: string | null = null;
    let cur = parent.get(id);
    for (let guard = 0; cur && launches.has(cur) && guard < 32; guard++) {
      top = cur;
      cur = parent.get(cur);
    }
    return top;
  };
  const items: PermissionBatchItem[] = [];
  entries.forEach((e, index) => {
    if (e?.type !== "permission" || e.chosen != null) return;
    const agentId = e.toolCallId ? root(e.toolCallId) : null;
    const launch = agentId ? launches.get(agentId) : undefined;
    items.push({ index, agentId, agent: launch ? (subagentInfo(launch)?.name ?? "Sub-agent") : null });
  });
  if (items.length < 1) return null;
  return { items, mixed: new Set(items.map((i) => i.agentId)).size > 1 };
}

/** The option a plain Allow (or Deny) picks: the one-off one, never an "always" option. */
export const onceOption = (options: readonly { optionId: string; kind: string }[], kind: "allow_once" | "reject_once") =>
  options.find((o) => o.kind === kind)?.optionId;

/** The option Esc picks: the one-off denial, else any denial. */
export const denyOption = (options: readonly { optionId: string; kind: string }[]) =>
  onceOption(options, "reject_once") ?? options.find((o) => o.kind.startsWith("reject"))?.optionId;
