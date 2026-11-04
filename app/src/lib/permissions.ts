// How an answered permission request is drawn (session/permissions.rs decides; this only reads
// what it recorded). An allowed request folds into its tool call's card as a chip; a pending one
// keeps its full card, a denied one a compact card.
import type { Entry } from "@/lib/api";

export type PermissionEntry = Extract<Entry, { type: "permission" }>;

/** session.rs `REMEMBERED`: the mark on a "don't ask again" replay's chosen name. */
const REMEMBERED = /\s*\(you said don't ask again\)$/;

/**
 * The kind of option a request was answered with, or "cancelled"; null while it waits (or when
 * it can't be told). Rust records `answer`, and fills it in for chats saved before it existed;
 * reading `chosen` here covers an entry that still has none.
 */
export function permissionAnswer(e: PermissionEntry): string | null {
  if (e.answer) return e.answer;
  if (e.chosen == null) return null;
  if (e.chosen.startsWith("cancelled")) return "cancelled";
  const name = e.chosen.replace(REMEMBERED, "");
  return e.options.find((o) => o.name === name)?.kind ?? null;
}

export const isAllowed = (answer: string | null) => answer === "allow_once" || answer === "allow_always";

export type PermissionChip = { label: "Allowed" | "Always allowed" | "Auto-allowed"; reason?: string };

/** The chip an allowed request puts on its tool card; null for one that isn't allowed. */
export function permissionChip(e: PermissionEntry): PermissionChip | null {
  const answer = permissionAnswer(e);
  if (!isAllowed(answer)) return null;
  if (e.auto?.reason === "remembered" || (!e.auto && REMEMBERED.test(e.chosen ?? "")))
    return { label: "Always allowed", reason: e.auto?.why ?? "you said don't ask again in this chat" };
  if (e.auto) return { label: "Auto-allowed", reason: e.auto.why };
  return { label: answer === "allow_always" ? "Always allowed" : "Allowed" };
}

/** Whether yaah answered `e` itself for a reason of its own (read-only, a trusted server, a saved tool result, a web search): not a "don't ask again" replay. */
export const isAutoAllowed = (e: PermissionEntry | undefined) => !!e?.auto && e.auto.reason !== "remembered" && isAllowed(permissionAnswer(e));

/**
 * The allowed requests that fold into a tool card, by tool call id (the last one wins): those
 * whose tool call is in `entries`. Their own entries aren't drawn.
 */
export function foldedPermissions(entries: readonly (Entry | undefined)[]): Map<string, PermissionEntry> {
  const tools = new Set<string>();
  for (const e of entries) if (e?.type === "tool") tools.add(e.toolCallId);
  const folded = new Map<string, PermissionEntry>();
  for (const e of entries)
    if (e?.type === "permission" && e.toolCallId && tools.has(e.toolCallId) && isAllowed(permissionAnswer(e))) folded.set(e.toolCallId, e);
  return folded;
}

/** Whether `e` is drawn as its tool card's chip rather than on its own. */
export function isFolded(e: Entry, folded: Map<string, PermissionEntry>): boolean {
  return e.type === "permission" && !!e.toolCallId && folded.has(e.toolCallId) && isAllowed(permissionAnswer(e));
}
