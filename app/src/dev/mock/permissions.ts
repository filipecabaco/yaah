// Permission requests as session/permissions.rs answers them: reads inside the chat's folders
// and a trusted MCP server's tools allowed without asking (marked), everything else asked.
// `triage ENG-142` plays a chat with each case; `trust_mcp_server` trusts a request's server.
import type { Entry, PermissionOption, Project, SessionInfo } from "@/lib/api";
import { ws } from "./context";
import type { Recording } from "./fixtures";

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

/** The trusted servers that apply to chat `s`: its project's, or its own. */
export function trustedFor(s: SessionInfo, projects: Project[]): string[] {
  const project = s.projectId ? projects.find((p) => p.id === s.projectId) : undefined;
  return project ? (project.trustedMcpServers ?? []) : (s.trustedMcpServers ?? []);
}

/** A waiting request for a trusted server's tool, answered as session.rs would (allow_once, marked); else null. */
export function trustedAnswer(entry: Permission, trusted: string[]): Permission | null {
  const server = entry.mcpServer;
  const once = entry.options.find((o) => o.kind === "allow_once");
  if (entry.chosen != null || !server || !once || !trusted.includes(server.id)) return null;
  return { ...entry, chosen: once.name, answer: "allow_once", auto: { reason: "trustedServer", why: `trusted server: ${server.label}` } };
}
