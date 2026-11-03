// Chats (session.rs): sessions, transcripts, and prompts answered by replaying
// a recorded chat chosen by keywords in the prompt (see `routes`). A replay
// pauses on a permission card until `respond_permission`, and on a form the
// agent asked with (ui_ask) until `answer_ui`; `cancel_turn` stops it.
import type { Entry, Project, SessionInfo, SlashCommand } from "@/lib/api";
import { baseName, home, need, now, type Mock, type Replies } from "./context";
import { recordings, type Recording } from "./fixtures";
import { addProject } from "./projects";

/** A new, empty chat (session.rs `new_session`). */
export function openChat({ state }: Mock, fields: Pick<SessionInfo, "projectId" | "accountId" | "cwd" | "additionalDirs">): SessionInfo {
  const sessionId = `replay-${state.nextChat++}`;
  state.transcripts[sessionId] = [];
  return (state.sessions[sessionId] = {
    sessionId,
    ...fields,
    title: "New chat",
    running: false,
    stopReason: null,
    commands: slashCommands,
    createdAt: now(),
  });
}

/** A chat in a project, running in its first folder (session.rs `ChatTarget::Project`). */
export function openProjectChat(m: Mock, p: Project, accountId: string): SessionInfo {
  const [cwd = p.contextDir, ...rest] = p.dirs;
  return openChat(m, { projectId: p.id, accountId, cwd, additionalDirs: p.dirs.length ? [...rest, p.contextDir] : [] });
}

/** The replay answering a chat's latest prompt. */
type Turn = { cancelled: boolean; resume?: () => void; answered: Set<number> };

export function seedChats() {
  return {
    sessions: {} as Record<string, SessionInfo>,
    /** Every entry shown in each chat, by index (entries are replaced, never mutated). */
    transcripts: {} as Record<string, Entry[]>,
    turns: {} as Record<string, Turn>,
    nextChat: 1,
  };
}

const slashCommands: SlashCommand[] = [
  { name: "review", description: "Review the current changes", input: null },
  { name: "init", description: "Write a CLAUDE.md for this project", input: null },
  { name: "compact", description: "Summarise the conversation to free up context", input: { hint: "what to keep" } },
  { name: "model", description: "Switch the model for this chat", input: { hint: "model name" } },
];

/** A generated multi-file patch, to see how big diffs render. */
function bigPatch(): string {
  const files = [
    "src/billing/invoice.ts",
    "src/billing/pricing.ts",
    "src/billing/tax.ts",
    "src/billing/currency.ts",
    "src/api/routes.ts",
    "src/api/auth.ts",
    "src/db/schema.sql",
    "src/db/migrations/0042_pricing.sql",
    "src/components/InvoiceTable.tsx",
    "src/components/PriceTag.tsx",
    "src/lib/money.ts",
    "test/billing/invoice.test.ts",
    "test/billing/pricing.test.ts",
    "docs/pricing.md",
    "package.json",
  ];
  return files
    .map((f, i) => {
      const n = 6 + ((i * 37) % 60);
      const removed = Array.from({ length: Math.floor(n / 3) }, (_, k) => `-  const old${k} = legacyPrice(${k});`);
      const added = Array.from({ length: n }, (_, k) => `+  const price${k} = pricing.for(plan, ${k}); // ${f}`);
      const body = [" export function compute() {", ...removed, ...added, "   return total;", " }"];
      return `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -10,${removed.length + 3} +10,${added.length + 3} @@\n${body.join("\n")}`;
    })
    .join("\n");
}

/** The prompt, then one `patch` UI with the big diff. */
const bigDiff: Recording = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  {
    event: "session-entry",
    index: 1,
    entry: {
      type: "ui",
      askId: null,
      answer: null,
      title: null,
      component: null,
      version: null,
      tree: { type: "patch", props: { text: bigPatch(), title: "Pricing migration across billing, api and db" } },
      props: {},
    },
  },
  { event: "session-info", running: false, stopReason: "end_turn" },
];

/** The prompt, the agent's notices about MCP servers that didn't come up (as session.rs merges ACP notices), then a reply. */
const notices: Recording = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  {
    event: "session-entry",
    index: 1,
    entry: {
      type: "notices",
      items: [
        { severity: "warning", title: 'MCP server "linear" needs authentication', description: "Run /mcp to sign in.", mcpServer: "linear" },
        {
          severity: "error",
          title: 'MCP server "sqlite" failed to start',
          description: "spawn uvx ENOENT. Run /mcp for the error.",
          mcpServer: "sqlite",
        },
      ],
    },
  },
  { event: "session-entry", index: 2, entry: { type: "agent", text: "I can't reach Linear or SQLite in this chat.", messageId: null } },
  { event: "session-info", running: false, stopReason: "end_turn" },
];

/** The prompt, then a Markdown reply with links (one web, one not) and a code block. */
const markdownReply: Recording = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  {
    event: "session-entry",
    index: 1,
    entry: {
      type: "agent",
      text: [
        "The retry logic follows the [ACP spec](https://agentclientprotocol.com/protocol/overview) and is set in [config.toml](config.toml).",
        "",
        "Run it with:",
        "",
        "```sh",
        "cargo test --lib retry",
        "```",
        "",
        "It backs off up to five times.",
      ].join("\n"),
      messageId: null,
    },
  },
  { event: "session-info", running: false, stopReason: "end_turn" },
];

/** A `ui_render` call as Claude streams it: pending with no input, in progress as the input arrives, then the UI and the call completed. */
const deployTree = {
  type: "card",
  props: { title: "Deploys" },
  children: [
    {
      type: "table",
      props: {
        columns: [
          { key: "service", label: "Service" },
          { key: "status", label: "Status" },
        ],
        rows: [
          { service: "api", status: "live" },
          { service: "web", status: "rolling out" },
        ],
      },
    },
  ],
};
const renderCall = (status: "pending" | "in_progress" | "completed", rawInput: unknown): Entry => ({
  type: "tool",
  toolCallId: "toolu_assemble",
  title: "mcp__yaah-ui__ui_render",
  kind: "other",
  status,
  content: status === "completed" ? [{ type: "content", content: { type: "text", text: "Rendered." } }] : [],
  locations: [],
  rawInput,
});
const assembling: Recording = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  { event: "session-entry", index: 1, entry: renderCall("pending", {}) },
  { event: "session-entry", index: 1, entry: renderCall("in_progress", { title: "Deploys" }) },
  { event: "session-entry", index: 1, entry: renderCall("in_progress", { title: "Deploys", tree: deployTree }) },
  {
    event: "session-entry",
    index: 2,
    entry: { type: "ui", askId: null, answer: null, title: "Deploys", component: null, version: null, tree: deployTree, props: {} },
  },
  { event: "session-entry", index: 1, entry: renderCall("completed", { title: "Deploys", tree: deployTree }) },
  { event: "session-entry", index: 3, entry: { type: "agent", text: "Here are the deploys: web is still rolling out.", messageId: null } },
  { event: "session-info", running: false, stopReason: "end_turn" },
];

/** Which recording answers a prompt: the first pattern it matches, else the permission chat. */
const routes: [RegExp, Recording][] = [
  [/big diff/i, bigDiff],
  [/assembl|deploys/i, assembling],
  [/\blinks?\b|markdown/i, markdownReply],
  [/notices|mcp servers?\b/i, notices],
  [/yaah (ui tools|components)|docker|bug report/i, recordings.pack],
  [/side project|weekend/i, recordings.ask],
  [/cities|scenario/i, recordings.scenarios],
  [/todo/i, recordings.showcase],
  [/status|\bui\b/i, recordings.ui],
];
const recordingFor = (text: string) => routes.find(([re]) => re.test(text))?.[1] ?? recordings.chat;

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/;
/** Every timestamp inside `v` moved by `ms`. */
function shiftTimes<T>(v: T, ms: number): T {
  if (!ms) return v;
  if (typeof v === "string" && ISO.test(v)) return new Date(Date.parse(v) + ms).toISOString() as T;
  if (Array.isArray(v)) return v.map((x: unknown) => shiftTimes(x, ms)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shiftTimes(x, ms)])) as T;
  return v;
}

/** Characters per `session-append` when a recorded reply is streamed. */
const STREAM_CHUNK = 48;
/** Entries `get_entries` returns when not told how many. */
const ENTRIES_PAGE = 200;

/** Two UI entries that differ only in their draft (what `session-draft` carries). */
function sameButDraft(a: Extract<Entry, { type: "ui" }>, b: Extract<Entry, { type: "ui" }>): boolean {
  const { draft: _a, draftBy: _ab, ...restA } = a;
  const { draft: _b, draftBy: _bb, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

export function stopTurn(turn: Turn | undefined) {
  if (!turn) return;
  turn.cancelled = true;
  turn.resume?.();
}

export function chatReplies(m: Mock): Replies {
  const { state } = m;
  const session = (id: string) => need(state.sessions[id], "unknown session");
  const shown = (sessionId: string, index: number) => state.transcripts[sessionId]?.[index];

  const showInfo = (s: SessionInfo) => m.emit("session-info", s);
  /**
   * Shows `entry` at `index` the way session.rs does: an agent message or thought
   * that starts or grows streams as `session-append`s (one per chunk, `len` in UTF-16
   * code units), a form whose draft alone changed is a `session-draft`, and anything
   * else a `session-entry`.
   */
  const show = async (sessionId: string, index: number, entry: Entry) => {
    const list = (state.transcripts[sessionId] ??= []);
    const prev = list[index];
    if (prev?.type === "ui" && entry.type === "ui" && sameButDraft(prev, entry)) {
      list[index] = entry;
      return m.emit("session-draft", { sessionId, index, draft: entry.draft ?? null, draftBy: entry.draftBy ?? null });
    }
    if ((entry.type === "agent" || entry.type === "thought") && (!prev || (prev.type === entry.type && entry.text.startsWith(prev.text)))) {
      let shown = prev?.type === entry.type ? prev.text.length : Math.min(entry.text.length, STREAM_CHUNK);
      if (!prev || prev.type !== entry.type) {
        list[index] = { ...entry, text: entry.text.slice(0, shown) };
        await m.emit("session-entry", { sessionId, index, entry: list[index] });
      }
      while (shown < entry.text.length) {
        await m.wait(16);
        const text = entry.text.slice(shown, shown + STREAM_CHUNK);
        shown += text.length;
        list[index] = { ...entry, text: entry.text.slice(0, shown) };
        await m.emit("session-append", { sessionId, index, field: "text", text, len: shown });
      }
      list[index] = entry;
      return;
    }
    list[index] = entry;
    return m.emit("session-entry", { sessionId, index, entry });
  };

  const open = (fields: Pick<SessionInfo, "projectId" | "accountId" | "cwd" | "additionalDirs">) => openChat(m, fields);

  /** Replays the recording for `text`, after what the chat already shows. */
  async function replay(sessionId: string, text: string, mentions: string[]) {
    const s = session(sessionId);
    stopTurn(state.turns[sessionId]);
    const turn: Turn = { cancelled: false, answered: new Set() };
    state.turns[sessionId] = turn;
    const pause = () => new Promise<void>((resume) => (turn.resume = resume));

    const recording = recordingFor(text);
    const offset = state.transcripts[sessionId]?.length ?? 0;
    const firstUser = recording.find((e) => e.event === "session-entry" && e.entry.type === "user");
    // Timestamps in recorded UI move by (now − recording time), so countdowns stay in the future.
    const recordedAt =
      firstUser?.event === "session-entry" && firstUser.entry.type === "user" ? /\d{4}-\d\d-\d\dT[\d:]+Z/.exec(firstUser.entry.text)?.[0] : undefined;
    const shift = recordedAt ? Date.now() - Date.parse(recordedAt) : 0;
    const rendered = new Set<number>();

    for (const step of recording) {
      if (turn.cancelled) return;
      if (step.event === "session-info") {
        // Keep the mock's own record in step, so e.g. a rename mid-turn doesn't look stopped.
        Object.assign(s, { running: step.running, stopReason: step.stopReason });
        await showInfo(s);
        continue;
      }
      const index = offset + step.index;
      // The user's own prompt replaces the recorded one (later recorded prompts stay).
      const entry: Entry =
        step === firstUser && step.entry.type === "user" ? { ...step.entry, text, attachments: mentions.map(baseName) } : step.entry;
      const isUpdate = entry.type === "ui" && rendered.has(index);
      if (entry.type === "ui") rendered.add(index);
      // The click supplies the permission choice and the form answer; skip the recorded ones.
      if (entry.type === "permission" && entry.chosen != null) continue;
      if (entry.type === "ui" && entry.answer != null && turn.answered.has(index)) continue;
      // In-place UI updates (e.g. a sub-agent panel) wait a while, as the real work did.
      await m.wait(isUpdate ? 6000 : entry.type === "agent" ? 120 : 350);
      if (turn.cancelled) return;
      await show(sessionId, index, entry.type === "ui" ? shiftTimes(entry, shift) : entry);
      if (entry.type === "permission" || (entry.type === "ui" && entry.askId && entry.answer == null)) await pause();
    }
  }

  return {
    list_sessions: (): SessionInfo[] => Object.values(state.sessions),
    new_session: ({ projectId, accountId }: { projectId: string; accountId: string }): SessionInfo => {
      const p = need(
        state.projects.find((x) => x.id === projectId),
        `no project ${projectId}`,
      );
      return openProjectChat(m, p, accountId);
    },
    new_quick_chat: ({ accountId, dir }: { accountId: string; dir: string | null }): SessionInfo =>
      open({ projectId: null, accountId, cwd: dir ?? `${home}/.yaah/scratch/3f9c2a7e41d0`, additionalDirs: [] }),
    set_chat_project: ({ sessionId, projectId }: { sessionId: string; projectId: string | null }): SessionInfo =>
      Object.assign(session(sessionId), { projectId }),
    promote_chat: ({ sessionId, name }: { sessionId: string; name: string }) => {
      const s = session(sessionId);
      const p = addProject(m, name, [s.cwd]);
      s.projectId = p.id;
      return [p, s];
    },
    get_transcript: ({ sessionId }: { sessionId: string }) => ({ info: session(sessionId), entries: state.transcripts[sessionId] ?? [] }),
    // A page of the transcript; without `from` and `limit`, the last 200 entries (session.rs `PAGE`).
    get_entries: ({ sessionId, from, limit }: { sessionId: string; from?: number | null; limit?: number | null }) => {
      session(sessionId);
      const all = state.transcripts[sessionId] ?? [];
      const total = all.length;
      const start = Math.min(total, from ?? Math.max(0, total - (limit ?? ENTRIES_PAGE)));
      const end = Math.min(total, limit == null ? (from == null ? start + ENTRIES_PAGE : total) : start + limit);
      return { entries: all.slice(start, end), from: start, total };
    },
    rename_session: async ({ sessionId, title }: { sessionId: string; title: string }): Promise<SessionInfo> => {
      const s = Object.assign(session(sessionId), { title });
      await showInfo(s);
      return s;
    },
    delete_session: ({ sessionId }: { sessionId: string }) => {
      stopTurn(state.turns[sessionId]);
      delete state.sessions[sessionId];
      delete state.transcripts[sessionId];
      delete state.turns[sessionId];
      return null;
    },

    send_prompt: ({ sessionId, text, mentions = [] }: { sessionId: string; text: string; mentions?: string[] }) => {
      const s = session(sessionId);
      if (!state.transcripts[sessionId]?.length) s.title = (text.split("\n")[0] ?? "").slice(0, 60);
      // The turn runs on after the command returns, as in Rust.
      replay(sessionId, text, mentions).catch((e: unknown) => console.error("[browser-mock] replay failed", e));
      return null;
    },
    respond_permission: async ({ sessionId, index, optionId }: { sessionId: string; index: number; optionId: string | null }) => {
      const request = shown(sessionId, index);
      if (request?.type !== "permission") throw new Error("no permission request at that index");
      const option = request.options.find((o) => o.optionId === optionId);
      await show(sessionId, index, { ...request, chosen: option?.name ?? "cancelled" });
      state.turns[sessionId]?.resume?.();
      return null;
    },
    answer_ui: async ({ sessionId, index, values }: { sessionId: string; index: number; values: Record<string, unknown> }) => {
      const ui = shown(sessionId, index);
      // The answer locks the form as shown.
      if (ui?.type === "ui") await show(sessionId, index, { ...ui, answer: values });
      const turn = state.turns[sessionId];
      turn?.answered.add(index);
      turn?.resume?.();
      return null;
    },
    // The user's side of the shared draft (the agent's arrives as recorded ui_set_values).
    edit_ui: async ({ sessionId, index, values }: { sessionId: string; index: number; values: Record<string, unknown> }) => {
      const ui = shown(sessionId, index);
      if (ui?.type !== "ui") return null;
      const by = Object.fromEntries(Object.keys(values).map((k) => [k, "user" as const]));
      // Only the draft goes out (session-draft), not the whole entry.
      await show(sessionId, index, { ...ui, draft: { ...ui.draft, ...values }, draftBy: { ...ui.draftBy, ...by } });
      return null;
    },
    cancel_turn: async ({ sessionId }: { sessionId: string }) => {
      stopTurn(state.turns[sessionId]);
      await showInfo(Object.assign(session(sessionId), { running: false, stopReason: "cancelled" }));
      return null;
    },
  };
}
