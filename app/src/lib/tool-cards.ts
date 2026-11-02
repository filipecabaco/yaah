// How a tool call's card opens in a chat, by kind of tool (Settings → Chat, or a
// card's right-click menu). Rules live in settings.json through Rust; this keeps
// the current ones for the cards to read.
import { useSyncExternalStore } from "react";
import { api } from "@/lib/api";

export type CardMode = "auto" | "collapsed" | "expanded";
export type CardRules = Record<string, CardMode>;

let rules: CardRules = {};
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export function setCardRules(r: CardRules) {
  rules = r;
  changed();
}

export function useCardRules(): CardRules {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => rules,
  );
}

/** Save one rule (`null` goes back to the default) and reload what is in effect. */
export async function saveCardRule(key: string, mode: CardMode | null) {
  if (mode) setCardRules({ ...rules, [key]: mode });
  await api.setToolCard(key, mode);
  setCardRules((await api.generalSettings()).toolCards.rules);
}

/**
 * The kind of tool a card is, for its rule:
 * - `mcp__server__tool` → itself (a rule on `mcp__server` covers the whole server)
 * - `Load skill: dataviz` → `Load skill`
 * - `ToolSearch` → `ToolSearch`
 * - anything else (a shell command, a file path…) → its ACP kind, e.g. `kind:execute`
 */
export function cardKey(title: string, kind: string | null | undefined): string {
  const t = title.trim();
  if (t.startsWith("mcp__")) return t;
  // `Label: detail`: a short label of words, then ": ". Not `curl http://x` or `echo a:b`.
  const labelled = /^([A-Za-z][\w ]{0,38}):\s/.exec(t);
  if (labelled) return labelled[1].trim();
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(t)) return t;
  return `kind:${kind || "other"}`;
}

/** What a rule key reads as in Settings. */
export function cardKeyLabel(key: string): string {
  if (key.startsWith("kind:")) {
    const k = key.slice(5);
    const names: Record<string, string> = {
      execute: "Commands",
      read: "File reads",
      edit: "Edits",
      delete: "Deletions",
      move: "Moves",
      search: "Searches",
      fetch: "Web fetches",
      think: "Thinking",
      other: "Other tools",
    };
    return `${names[k] ?? k} (any)`;
  }
  if (key.startsWith("mcp__") && key.split("__").length === 2) return `${key.slice(5)} (every tool of this MCP server)`;
  return key;
}

export function cardMode(r: CardRules, key: string): CardMode {
  if (r[key]) return r[key];
  if (key.startsWith("mcp__")) {
    const server = key.split("__").slice(0, 2).join("__");
    if (r[server]) return r[server];
  }
  return "auto";
}
