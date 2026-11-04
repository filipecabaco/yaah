// Permission requests as session/permissions.rs answers them: reads inside the chat's folders
// and a trusted MCP server's tools allowed without asking (marked), everything else asked.
// `triage ENG-142` plays a chat with each case; `trust_mcp_server` trusts a request's server.
import type { Entry, PermissionOption, Project, SessionInfo } from "@/lib/api";
import { home, ws } from "./context";
import type { Recording } from "./fixtures";
import { SCOPE_WORDS, type TrustScope, type TrustView } from "@/lib/trust-api";

type Permission = Extract<Entry, { type: "permission" }>;

const options: PermissionOption[] = [
  { optionId: "allow", name: "Yes", kind: "allow_once" },
  { optionId: "always", name: "Yes, and don't ask again", kind: "allow_always" },
  { optionId: "reject", name: "No", kind: "reject_once" },
];
const linear = { id: "claude_ai_Linear", label: "Linear" };
const tool = (
  toolCallId: string,
  title: string,
  kind: string,
  status: "pending" | "in_progress" | "completed" | "failed",
  extra: Partial<Entry> = {},
) => ({ type: "tool", toolCallId, title, kind, status, content: [], locations: [], rawInput: null, ...extra }) as Entry;
const text = (t: string) => [{ type: "content" as const, content: { type: "text", text: t } }];
const ask = (requestId: number, toolCallId: string, title: string, more: Partial<Permission> = {}): Entry => ({
  type: "permission",
  requestId,
  toolCallId,
  title,
  options,
  chosen: null,
  ...more,
});
const readOnly = { chosen: "Yes", answer: "allow_once" as const, auto: { reason: "readOnly", why: "read-only in this chat's folders" } };

/** Linear MCP reads (asked, until Linear is trusted), reads and a search auto-allowed, a command, and an `rm` the user should deny. */
export const permissionsReply: Recording = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  { event: "session-entry", index: 1, entry: { type: "agent", text: "I'll read the issue first, then the code it points at.", messageId: null } },
  {
    event: "session-entry",
    index: 2,
    entry: tool("t1", "mcp__claude_ai_Linear__get_issue", "other", "pending", { rawInput: { id: "ENG-142" } }),
  },
  { event: "session-entry", index: 3, entry: ask(1, "t1", "mcp__claude_ai_Linear__get_issue", { mcpServer: linear }) },
  {
    event: "session-entry",
    index: 2,
    entry: tool("t1", "mcp__claude_ai_Linear__get_issue", "other", "completed", {
      rawInput: { id: "ENG-142" },
      content: text("ENG-142 · Invoices round tax per line instead of per invoice"),
    }),
  },
  {
    event: "session-entry",
    index: 4,
    entry: tool("t2", "mcp__claude_ai_Linear__list_comments", "other", "pending", { rawInput: { issueId: "ENG-142" } }),
  },
  { event: "session-entry", index: 5, entry: ask(2, "t2", "mcp__claude_ai_Linear__list_comments", { mcpServer: linear }) },
  {
    event: "session-entry",
    index: 4,
    entry: tool("t2", "mcp__claude_ai_Linear__list_comments", "other", "completed", {
      rawInput: { issueId: "ENG-142" },
      content: text("2 comments: “Repro with the EU sample account”, “Rounding should be banker's”"),
    }),
  },
  {
    event: "session-entry",
    index: 6,
    entry: tool("t3", `Read ${ws}/api/src/billing/tax.ts`, "read", "completed", {
      locations: [{ path: `${ws}/api/src/billing/tax.ts` }],
      rawInput: { file_path: `${ws}/api/src/billing/tax.ts` },
      content: text("export function lineTax(line: Line) {\n  return round(line.amount * line.rate);\n}"),
    }),
  },
  { event: "session-entry", index: 7, entry: ask(3, "t3", `Read ${ws}/api/src/billing/tax.ts`, readOnly) },
  {
    event: "session-entry",
    index: 8,
    entry: tool("t4", `grep -n "round(" ${ws}/api/src`, "search", "completed", {
      rawInput: { pattern: "round(", path: `${ws}/api/src` },
      content: text("src/billing/tax.ts:2\nsrc/billing/invoice.ts:41"),
    }),
  },
  { event: "session-entry", index: 9, entry: ask(4, "t4", `grep -n "round(" ${ws}/api/src`, readOnly) },
  {
    event: "session-entry",
    index: 10,
    entry: tool("t5", "npm test -- billing", "execute", "in_progress", { rawInput: { command: "npm test -- billing" } }),
  },
  {
    event: "session-entry",
    index: 10,
    entry: tool("t5", "npm test -- billing", "execute", "failed", {
      rawInput: { command: "npm test -- billing" },
      content: text("FAIL src/billing/tax.test.ts\n  ✕ rounds per invoice (4 ms)\n\nTests: 1 failed, 11 passed"),
    }),
  },
  { event: "session-entry", index: 11, entry: tool("t6", "rm -rf build", "execute", "pending", { rawInput: { command: "rm -rf build" } }) },
  { event: "session-entry", index: 12, entry: ask(5, "t6", "rm -rf build") },
  { event: "session-entry", index: 11, entry: tool("t6", "rm -rf build", "execute", "failed", { content: text("The user refused permission.") }) },
  {
    event: "session-entry",
    index: 13,
    entry: {
      type: "agent",
      text: "The tax is rounded per line in `lineTax`, so a 12-line EU invoice drifts by up to 6 cents. The failing test pins it: round once, over the invoice total.",
      messageId: null,
    },
  },
  { event: "session-info", running: false, stopReason: "end_turn" },
];

/** What the mock keeps beside the chats and projects for trust.rs: all chats' and quick chats' servers. */
export type TrustState = { projects: Project[]; trustedEverywhere: string[]; quickTrusted: string[] };

/** trust.rs `scope_of`: the project's, quick chats' (no project, in a scratch folder), or the chat's own. */
export function scopeOf(s: SessionInfo): TrustScope {
  if (s.projectId) return "project";
  return /\/\.yaah\/scratch\/[^/]/.test(s.cwd) ? "quickChats" : "chat";
}

const OFFERED: Record<TrustScope, TrustScope[]> = {
  project: ["chat", "project", "everywhere"],
  quickChats: ["quickChats", "everywhere"],
  chat: ["chat", "everywhere"],
  everywhere: ["chat", "everywhere"],
};

/** trust.rs `trusted_for`: the servers trusted for chat `s`, by scope, narrowest first. */
export function trustedFor(s: SessionInfo, t: TrustState): [TrustScope, string[]][] {
  const here = scopeOf(s);
  const project = s.projectId ? t.projects.find((p) => p.id === s.projectId) : undefined;
  const scoped: [TrustScope, string[]][] =
    here === "quickChats"
      ? [["quickChats", t.quickTrusted]]
      : [
          ["chat", s.trustedMcpServers ?? []],
          ...(here === "project" ? [["project", project?.trustedMcpServers ?? []] as [TrustScope, string[]]] : []),
        ];
  return [...scoped, ["everywhere", t.trustedEverywhere]];
}

/** trust.rs `TrustView` for chat `s`. */
export function trustView(s: SessionInfo, t: TrustState): TrustView {
  const here = scopeOf(s);
  const label = (id: string) => id.replace(/^claude_ai_(?=.)/, "");
  const servers = trustedFor(s, t).flatMap(([scope, ids]) => ids.map((id) => ({ id, label: label(id), scope })));
  return { here, offered: OFFERED[here], servers };
}

/** A waiting request for a trusted server's tool, answered as session.rs would (allow_once, marked); else null. */
export function trustedAnswer(entry: Permission, trusted: [TrustScope, string[]][]): Permission | null {
  const server = entry.mcpServer;
  const once = entry.options.find((o) => o.kind === "allow_once");
  const scope = server && trusted.find(([, ids]) => ids.includes(server.id))?.[0];
  if (entry.chosen != null || !server || !once || !scope) return null;
  const reason = scope === "everywhere" ? "trustedEverywhere" : "trustedServer";
  return { ...entry, chosen: once.name, answer: "allow_once", auto: { reason, why: `trusted ${SCOPE_WORDS[scope]}: ${server.label}` } };
}

const results = `${home}/.claude-personal/projects/-Users-dev--yaah-scratch-3f9c2a7e41d0/5d1e9a40-7c2b-4f1e-9a3d-2b6c8e1f0a77/tool-results`;
const saved = `${results}/mcp-fetch-fetch-1.txt`;
const grep = `F=${saved}; grep -n "Wisconsin" $F | cut -c1-160`;

/**
 * A web search (auto-allowed when Settings allows web searches), a Read of Claude's saved tool result
 * (auto-allowed: its own folder for this chat), and a Bash read-back of the same file, which still asks
 * but says what it is (session/permissions.rs `command_note`).
 */
export const savedResultsReply: Recording = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  { event: "session-entry", index: 1, entry: { type: "agent", text: "I'll search first, then read the saved page.", messageId: null } },
  {
    event: "session-entry",
    index: 2,
    entry: tool("w1", 'Search "Wisconsin county population 2020"', "fetch", "completed", {
      rawInput: { query: "Wisconsin county population 2020" },
      content: text("Wisconsin counties by population (en.wikipedia.org)"),
    }),
  },
  {
    event: "session-entry",
    index: 3,
    entry: ask(6, "w1", 'Search "Wisconsin county population 2020"', {
      chosen: "Yes",
      answer: "allow_once",
      auto: { reason: "webSearch", why: "web search allowed in Settings" },
    }),
  },
  {
    event: "session-entry",
    index: 4,
    entry: tool("r1", `Read ${saved}`, "read", "completed", {
      locations: [{ path: saved }],
      rawInput: { file_path: saved, offset: 1, limit: 200 },
      content: text("Output too large; first 200 lines of the saved page"),
    }),
  },
  {
    event: "session-entry",
    index: 5,
    entry: ask(7, "r1", `Read ${saved}`, {
      chosen: "Yes",
      answer: "allow_once",
      auto: { reason: "toolResults", why: "Claude's saved tool result from this chat" },
    }),
  },
  {
    event: "session-entry",
    index: 6,
    entry: tool("b1", grep, "execute", "pending", { rawInput: { command: grep, description: "Find Wisconsin rows" } }),
  },
  { event: "session-entry", index: 7, entry: ask(8, "b1", grep, { note: "Claude is reading a saved tool result" }) },
  {
    event: "session-entry",
    index: 6,
    entry: tool("b1", grep, "execute", "completed", { rawInput: { command: grep }, content: text("412:| Milwaukee | 939,489 |") }),
  },
  { event: "session-entry", index: 8, entry: { type: "agent", text: "Milwaukee County had 939,489 people in 2020.", messageId: null } },
  { event: "session-info", running: false, stopReason: "end_turn" },
];
