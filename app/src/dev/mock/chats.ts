// Chats (session.rs): sessions, transcripts, and prompts answered by replaying
// a recorded chat chosen by keywords in the prompt (see `routes`). A replay
// pauses on a permission card until `respond_permission`, and on a form the
// agent asked with (ui_ask) until `answer_ui`; `cancel_turn` stops it.
import type { Entry, Project, SessionInfo, SlashCommand } from "@/lib/api";
import { baseName, home, need, now, type Mock, type Replies } from "./context";
import { bundledComponents, recordings, type Recording } from "./fixtures";
import { chartGallery } from "./chart-gallery";
import { mapGallery } from "./map-gallery";
import { mapTypes } from "./map-types";
import { flowGraphs } from "./flow-graphs";
import { addProject } from "./projects";
import { permissionsReply, savedResultsReply, scopeOf, trustedAnswer, trustedFor, trustView } from "./permissions";
import { SCOPE_WORDS, type TrustScope } from "@/lib/trust-api";
import { initialConfig } from "./config";
import { screenshotChat, takeStaged } from "./attachments";
import { referenceEntry, referencesIn } from "./references";
import { mockQueue } from "./queue";
import type { Attachment } from "@/lib/attachments";
import type { DiffMode } from "@/lib/layout";

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
    extraDirs: [],
    config: initialConfig(state, fields.accountId),
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

export const slashCommands: SlashCommand[] = [
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
        "How the examples compare:",
        "",
        "| example | linking | forks | threads | what's missing |",
        "|---|---|---|---|---|",
        "| **go** (Bubble Tea TUI) | static | 0 | 8 | a few file reads (`openat`, `pread64`), terminal calls, **signal delivery** (33 `rt_sigreturn`: Go's preemption and resize handling), `pipe2` |",
        "| **python** (REPL) | dynamic musl | 0 | 14 | **dynamic linking** (122 shared libraries), a filesystem (1,306 opens, 2,641 stats), `pselect6` on the terminal, `sysinfo`, `mbind` (can be refused) |",
        "| **duckdb** | dynamic (C++) | 1 | 74 | the same as python, plus `getcpu` |",
        "",
        "It backs off up to five times.",
      ].join("\n"),
      messageId: null,
    },
  },
  { event: "session-info", running: false, stopReason: "end_turn" },
];

/** A docs page section written in MDX (Supabase style), streamed: drawn as data, nothing in it runs. */
const mdxReply: Recording = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  {
    event: "session-entry",
    index: 1,
    entry: {
      type: "agent",
      text: [
        "---",
        "id: realtime-postgres-changes",
        "title: Postgres Changes",
        "description: Listen to Postgres changes with Supabase Realtime.",
        "---",
        "",
        'import { Admonition, Tabs, TabPanel } from "ui";',
        'export const meta = { sidebar: "realtime" };',
        "",
        "## Listen to inserts",
        "",
        "Subscribe to new rows in the `messages` table of project {props.projectRef}.",
        "",
        '<Admonition type="caution" title="Turn on replication first">',
        "",
        "Realtime only sees tables in the `supabase_realtime` **publication**. Add yours in the dashboard, or with SQL.",
        "",
        "</Admonition>",
        "",
        '<Tabs scrollable size="small" type="underlined" defaultActiveId="js" queryGroup="language">',
        '  <TabPanel id="js" label="JavaScript">',
        "",
        "```js",
        "const channel = supabase",
        '  .channel("schema-db-changes")',
        '  .on("postgres_changes", { event: "INSERT", schema: "public" }, (payload) => console.log(payload))',
        "  .subscribe();",
        "```",
        "",
        "  </TabPanel>",
        '  <TabPanel id="dart" label="Dart">',
        "",
        "```dart",
        "supabase.channel('schema-db-changes').onPostgresChanges(",
        "  event: PostgresChangeEvent.insert, schema: 'public', callback: print,",
        ").subscribe();",
        "```",
        "",
        "  </TabPanel>",
        "</Tabs>",
        "",
        "<Steps>",
        '<Step title="Enable the publication">Run `alter publication supabase_realtime add table messages;`.</Step>',
        '<Step title="Subscribe">Open the channel from your client, as above.</Step>',
        "</Steps>",
        "",
        "<details>",
        "<summary>Why am I not getting `DELETE` events?</summary>",
        "",
        "Set the table's replica identity to `full` so old rows are sent too.",
        "",
        "</details>",
        "",
        '<RealtimeLimits plan="pro">',
        "",
        "Up to 500 concurrent connections on Pro.",
        "",
        "</RealtimeLimits>",
        "",
        "{/* Nothing above runs: this comment stays hidden. */}",
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

/**
 * The agent's `ui_open_pane` (ui_mcp.rs), as the replay sends it: a diff of the chat's folder, or the UI
 * at a recorded index of this turn. The replay fills in the chat, its folder and the real index.
 */
type OpenPaneStep = {
  event: "ui-open-pane";
  direction?: "right" | "down";
  content: { kind: "diff"; mode?: DiffMode } | { kind: "ui"; index: number };
};
type MockStep = Recording[number] | OpenPaneStep;

const openPaneCall = (status: "in_progress" | "completed", rawInput: unknown, text?: string): Entry => ({
  type: "tool",
  toolCallId: "toolu_open_pane",
  title: "mcp__yaah-ui__ui_open_pane",
  kind: "other",
  status,
  content: text == null ? [] : [{ type: "content", content: { type: "text", text } }],
  locations: [],
  rawInput,
});
const deploysLive = {
  ...deployTree,
  children: [
    {
      type: "table",
      props: {
        columns: deployTree.children[0].props.columns,
        rows: [
          { service: "api", status: "live" },
          { service: "web", status: "live" },
        ],
      },
    },
  ],
};
const deploysEntry = (tree: unknown): Entry => ({
  type: "ui",
  askId: null,
  answer: null,
  title: "Deploys",
  component: null,
  version: null,
  tree,
  props: {},
});
/** "Pin the deploys in a side pane": render, move it into a pane, then update it there (same index, as the same `id` does). */
const sidePaneUi: readonly MockStep[] = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  { event: "session-entry", index: 1, entry: deploysEntry(deployTree) },
  { event: "session-entry", index: 2, entry: openPaneCall("in_progress", { what: "ui", id: "deploys" }) },
  { event: "ui-open-pane", content: { kind: "ui", index: 1 } },
  {
    event: "session-entry",
    index: 2,
    entry: openPaneCall("completed", { what: "ui", id: "deploys" }, "Moved the UI into a pane to the right of this chat; the chat links to it."),
  },
  {
    event: "session-entry",
    index: 3,
    entry: { type: "agent", text: "The deploys are pinned beside the chat; I'll keep them current.", messageId: null },
  },
  { event: "session-entry", index: 1, entry: deploysEntry(deploysLive) },
  { event: "session-info", running: false, stopReason: "end_turn" },
];
/** "Open the diff in a side pane": the chat's folder, every change. */
const sidePaneDiff: readonly MockStep[] = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  { event: "session-entry", index: 1, entry: openPaneCall("in_progress", { what: "diff" }) },
  { event: "ui-open-pane", content: { kind: "diff", mode: "all" } },
  { event: "session-entry", index: 1, entry: openPaneCall("completed", { what: "diff" }, "Opened the diff in a pane to the right of this chat.") },
  { event: "session-entry", index: 2, entry: { type: "agent", text: "The diff is open beside the chat.", messageId: null } },
  { event: "session-info", running: false, stopReason: "end_turn" },
];

/** A tool call as Claude's adapter sends it: shell output comes as a ```console fence. */
const call = (id: string, title: string, kind: string, status: "in_progress" | "completed", rawInput: unknown, text?: string): Entry => ({
  type: "tool",
  toolCallId: id,
  title,
  kind,
  status,
  content: text == null ? [] : [{ type: "content", content: { type: "text", text } }],
  locations: [],
  rawInput,
});
const consoleFence = (out: string) => "```console\n" + out.trimEnd() + "\n```";
const reviewDiff = `diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts
index 3b18e51..a4c09f2 100644
--- a/src/billing/invoice.ts
+++ b/src/billing/invoice.ts
@@ -12,9 +12,12 @@ export function total(lines: Line[], plan: Plan): Money {
 \tconst subtotal = lines.reduce((sum, l) => sum + l.qty * l.price, 0);
-\tconst tax = subtotal * 0.2;
-\treturn round(subtotal + tax);
+\tconst rate = taxRate(plan.country);
+\tconst tax = subtotal * rate;
+\t// Discounts apply before tax, never after.
+\tconst discounted = applyDiscount(subtotal, plan.discount);
+\treturn round(discounted + discounted * rate);
 }

 export function due(invoice: Invoice): Date {`;
const gitLog = `a4c09f2 (HEAD -> feat/tax-rates) Apply discounts before tax
9e1d2b7 Read the tax rate from the plan's country
51c0a3e (origin/main, main) Release 0.2.0
4ca8510 Let the Component library be closed`;
const cargoOut = `   Compiling billing v0.4.1 (/Users/dev/workspace/billing)
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 6.12s
     Running unittests src/lib.rs (target/debug/deps/billing-5c2e1f0a9b3d7e64)

running 3 tests
test invoice::tests::discount_applies_before_tax ... ok
test invoice::tests::tax_rate_follows_the_country ... ok
test invoice::tests::rounds_to_cents ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s`;
const citiesTree = {
  type: "card",
  props: { title: "Where the invoices go" },
  children: [
    {
      type: "tabs",
      children: [
        {
          type: "tab",
          props: { label: "Map" },
          children: [
            {
              type: "map",
              props: {
                markers: [
                  { lat: 51.5072, lng: -0.1276, label: "London · 412" },
                  { lat: 52.52, lng: 13.405, label: "Berlin · 198" },
                  { lat: 38.7223, lng: -9.1393, label: "Lisbon · 87" },
                ],
              },
            },
          ],
        },
        {
          type: "tab",
          props: { label: "Table" },
          children: [
            {
              type: "table",
              props: {
                columns: [
                  { key: "city", label: "City" },
                  { key: "invoices", label: "Invoices" },
                  { key: "rate", label: "Tax rate" },
                ],
                rows: [
                  { city: "London", invoices: 412, rate: "20%" },
                  { city: "Berlin", invoices: 198, rate: "19%" },
                  { city: "Lisbon", invoices: 87, rate: "23%" },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};
const renderInput = { title: "Where the invoices go", tree: citiesTree };
/** The tool cards a coding turn makes: tools loaded, commands run (a diff, a log, cargo), pages fetched, UI built. */
const commandOutput: Recording = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  {
    event: "session-entry",
    index: 1,
    entry: call("ts", "ToolSearch", "other", "completed", { query: "select:mcp__yaah-ui__ui_catalog,mcp__yaah-ui__ui_render" }, "Loaded 2 tools."),
  },
  { event: "session-entry", index: 2, entry: call("cat", "mcp__yaah-ui__ui_catalog", "other", "completed", {}, "(catalog)") },
  {
    event: "session-entry",
    index: 3,
    entry: call("diff", "git diff main...HEAD", "execute", "completed", { command: "git diff main...HEAD" }, consoleFence(reviewDiff)),
  },
  {
    event: "session-entry",
    index: 4,
    entry: call(
      "log",
      "git log --oneline --decorate -4",
      "execute",
      "completed",
      { command: "git log --oneline --decorate -4" },
      consoleFence(gitLog),
    ),
  },
  {
    event: "session-entry",
    index: 5,
    entry: call("cargo", "cargo test invoice", "execute", "completed", { command: "cargo test invoice" }, consoleFence(cargoOut)),
  },
  {
    event: "session-entry",
    index: 6,
    entry: call(
      "fetch1",
      "mcp__fetch__fetch",
      "other",
      "completed",
      { url: "https://www.gov.uk/guidance/rates-of-vat-on-different-goods-and-services" },
      "VAT rates…",
    ),
  },
  {
    event: "session-entry",
    index: 7,
    entry: call(
      "fetch2",
      "Fetch https://taxation-customs.ec.europa.eu/vat-rates",
      "fetch",
      "completed",
      { url: "https://taxation-customs.ec.europa.eu/vat-rates" },
      "EU VAT rates…",
    ),
  },
  { event: "session-entry", index: 8, entry: call("ui", "mcp__yaah-ui__ui_render", "other", "in_progress", {}) },
  { event: "session-entry", index: 8, entry: call("ui", "mcp__yaah-ui__ui_render", "other", "in_progress", renderInput) },
  {
    event: "session-entry",
    index: 9,
    entry: { type: "ui", askId: null, answer: null, title: "Where the invoices go", component: null, version: null, tree: citiesTree, props: {} },
  },
  { event: "session-entry", index: 8, entry: call("ui", "mcp__yaah-ui__ui_render", "other", "completed", renderInput, "Rendered.") },
  {
    event: "session-entry",
    index: 10,
    entry: {
      type: "agent",
      text: "Discounts now apply before tax, and the rate comes from the plan's country. The three invoice tests pass; London has the most invoices at 20%.",
      messageId: null,
    },
  },
  { event: "session-info", running: false, stopReason: "end_turn" },
];

/** The yaah repo, outside a quick chat's scratch folder: the agent asks for it (`ui_request_folders`). */
const yaahRepo = `${home}/Documents/workspace/yaah`;
const reviewComponent = bundledComponents.find((c) => c.name === "diff-review");
const reviewProps = { repo: yaahRepo, range: "HEAD~1", title: "yaah: the last commit against the one before" };
/** A diff of a repo outside the chat: ask for the folder once, then diff-review with `repo` (no shell commands). */
const folderRequest: Recording = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  { event: "session-entry", index: 1, entry: call("rf", "mcp__yaah-ui__ui_request_folders", "other", "in_progress", { paths: [yaahRepo] }) },
  {
    event: "session-entry",
    index: 2,
    entry: { type: "folderRequest", paths: [yaahRepo], reason: "to show the diff of your yaah project", askId: "ask-folders", answer: null },
  },
  {
    event: "session-entry",
    index: 1,
    entry: call("rf", "mcp__yaah-ui__ui_request_folders", "other", "completed", { paths: [yaahRepo] }, `The user added ${yaahRepo} to this chat.`),
  },
  {
    event: "session-entry",
    index: 3,
    entry: {
      type: "ui",
      askId: null,
      answer: null,
      title: null,
      component: "diff-review",
      version: reviewComponent?.version ?? 1,
      tree: { type: "$component", name: "diff-review", version: reviewComponent?.version ?? 1, props: reviewProps, tree: reviewComponent?.tree },
      props: reviewProps,
    },
  },
  { event: "session-entry", index: 4, entry: { type: "agent", text: "Here is the last commit of yaah against the one before it.", messageId: null } },
  { event: "session-info", running: false, stopReason: "end_turn" },
];

/** Library components with their first example, one UI each (file-view as .mdx and as source): to try Expand on every kind of scroll area. */
const MDX_SAMPLE = `# Release notes\n\n${Array.from({ length: 20 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} with some **bold** text and \`code\`.\n`).join("\n")}`;
const expandFill: Recording = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  ...(
    [
      ["file-view", { text: MDX_SAMPLE, path: "docs/release.mdx" }],
      ["file-view", undefined],
      ["container-logs", undefined],
      ["test-report", undefined],
      ["git-graph", undefined],
      ["db-query", undefined],
    ] as [string, Record<string, unknown> | undefined][]
  ).map(([name, props], i): Recording[number] => {
    const c = bundledComponents.find((b) => b.name === name);
    const given = props ?? c?.examples?.[0]?.props ?? {};
    return {
      event: "session-entry",
      index: i + 1,
      entry: {
        type: "ui",
        askId: null,
        answer: null,
        title: null,
        component: c?.name ?? name,
        version: c?.version ?? 1,
        tree: { type: "$component", name: c?.name, version: c?.version ?? 1, props: given, tree: c?.tree },
        props: given,
      },
    };
  }),
  { event: "session-info", running: false, stopReason: "end_turn" },
];

/**
 * An election-night dashboard, the shape an agent built for "US election dashboard": tabs, stat
 * tiles, the poll-against-result dumbbell with a Tie line, a stacked area of the count with end
 * labels, and the marker map. Margins are Republican minus Democrat, in points; the numbers are
 * illustrative, not real results.
 */
const ELECTION = [
  ["IA", 8.2, 13.2, 41.9, -93.1],
  ["LA", 15.0, 22.0, 31.0, -92.0],
  ["AK", 9.0, 13.1, 61.4, -150.5],
  ["SC", 12.0, 17.8, 33.9, -80.9],
  ["OH", 8.0, 11.2, 40.4, -82.9],
  ["ME", -8.0, -6.9, 45.3, -69.2],
  ["TX", 7.2, 13.7, 31.0, -99.9],
  ["KS", 12.0, 16.2, 38.5, -98.4],
  ["MI", -0.8, 1.4, 44.3, -85.6],
  ["MN", -4.6, -4.2, 46.7, -94.7],
  ["NH", -5.0, -2.8, 43.2, -71.6],
  ["GA", 1.0, 2.2, 32.7, -83.4],
  ["FL", 7.0, 13.1, 28.0, -81.8],
  ["NC", 1.2, 3.2, 35.6, -79.4],
] as const;
const margin = (v: number) => (v === 0 ? "Tie" : `${v > 0 ? "R" : "D"} +${Math.abs(v).toFixed(1)}`);
const electionTree = {
  type: "card",
  props: { title: "Election night: polls against results", description: "14 states. Margin is Republican minus Democrat, in points." },
  children: [
    {
      type: "grid",
      props: { columns: 3, gap: "md" },
      children: [
        { type: "stat", props: { label: "Average polling miss", value: "R +3.6 pts", hint: "Toward Republicans in all 14 states" } },
        { type: "stat", props: { label: "Missed by more than 3 points", value: "8 of 14" } },
        { type: "stat", props: { label: "Closest result", value: "MI, R +1.4" } },
      ],
    },
    {
      type: "tabs",
      children: [
        {
          type: "tab",
          props: { label: "Polls vs results" },
          children: [
            {
              type: "chart",
              props: {
                kind: "dumbbell",
                x: "state",
                data: ELECTION.map(([state, poll, result]) => ({ state, poll, result })),
                series: [
                  { key: "poll", label: "Final poll average" },
                  { key: "result", label: "Result" },
                ],
                refs: [{ axis: "y", value: 0, label: "Tie" }],
                sort: "gap",
                unit: " pts",
                scale: { type: "diverging", domain: [-24, 24], midpoint: 0, bins: 5, unit: " pts" },
              },
            },
          ],
        },
        {
          type: "tab",
          props: { label: "Count over the night" },
          children: [
            {
              type: "chart",
              props: {
                kind: "area",
                stacked: true,
                x: "hour",
                unit: "M",
                data: [
                  { hour: "7pm", early: 18.2, day: 0.4, mail: 0.2 },
                  { hour: "8pm", early: 31.5, day: 6.1, mail: 1.9 },
                  { hour: "9pm", early: 38.8, day: 15.4, mail: 4.6 },
                  { hour: "10pm", early: 41.2, day: 24.9, mail: 7.8 },
                  { hour: "11pm", early: 42.0, day: 31.7, mail: 10.3 },
                  { hour: "12am", early: 42.3, day: 35.2, mail: 12.9 },
                  { hour: "1am", early: 42.4, day: 36.8, mail: 15.1 },
                ],
                series: [
                  { key: "early", label: "Early in person" },
                  { key: "day", label: "Election day" },
                  { key: "mail", label: "Mail" },
                ],
              },
            },
          ],
        },
        {
          type: "tab",
          props: { label: "Map" },
          children: [
            {
              type: "map",
              props: {
                // States filled by their result on the same diverging scale as the dumbbell; the rest weren't in this set.
                kind: "choropleth",
                region: "us-states",
                title: "Result margin in the 14 states",
                data: ELECTION.map(([state, , result]) => ({ id: state, value: result, detail: margin(result) })),
                scale: { type: "diverging", domain: [-24, 24], midpoint: 0, bins: 7, unit: " pts" },
                legend: { title: "Result margin (R + / D −)" },
                // 37 states have no row: plain land, not 37 hatched "no data" states drowning the 14.
                missing: "land",
                noDataLabel: "Not in this set",
              },
            },
          ],
        },
      ],
    },
  ],
};
const electionInput = { title: "Election night", tree: electionTree };
const election: Recording = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  { event: "session-entry", index: 1, entry: call("ui", "mcp__yaah-ui__ui_render", "other", "in_progress", electionInput) },
  {
    event: "session-entry",
    index: 2,
    entry: { type: "ui", askId: null, answer: null, title: "Election night", component: null, version: null, tree: electionTree, props: {} },
  },
  { event: "session-entry", index: 1, entry: call("ui", "mcp__yaah-ui__ui_render", "other", "completed", electionInput, "Rendered.") },
  {
    event: "session-entry",
    index: 3,
    entry: {
      type: "agent",
      text: "The polls missed toward Republicans in all 14 states, by 3.6 points on average; Louisiana and Texas moved most, Minnesota least. (Illustrative numbers.)",
      messageId: null,
    },
  },
  { event: "session-info", running: false, stopReason: "end_turn" },
];

/** "chart gallery": a short message, then one small dashboard per subject (chart-gallery.ts). */
const gallery: Recording = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  {
    event: "session-entry",
    index: 1,
    entry: {
      type: "agent",
      text: "Here are eight small dashboards, one per subject, each with a different chart or map. All numbers are made up.",
      messageId: null,
    },
  },
  ...chartGallery.flatMap(([title, tree], i): Recording => {
    const input = { title, tree };
    const id = `gallery-${i}`;
    return [
      { event: "session-entry", index: 2 + i * 2, entry: call(id, "mcp__yaah-ui__ui_render", "other", "in_progress", input) },
      {
        event: "session-entry",
        index: 3 + i * 2,
        entry: { type: "ui", askId: null, answer: null, title, component: null, version: null, tree, props: {} },
      },
      { event: "session-entry", index: 2 + i * 2, entry: call(id, "mcp__yaah-ui__ui_render", "other", "completed", input, "Rendered.") },
    ];
  }),
  { event: "session-info", running: false, stopReason: "end_turn" },
];

/** "map gallery": a short message, then one card per map example (map-gallery.ts). */
const mapGalleryRecording: Recording = [
  { event: "session-info", running: true, stopReason: null },
  { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
  {
    event: "session-entry",
    index: 1,
    entry: {
      type: "agent",
      text: "Here are eight map examples, from one bike station to a whole continent. All data is made up.",
      messageId: null,
    },
  },
  ...mapGallery.flatMap(([title, tree], i): Recording => {
    const input = { title, tree };
    const id = `map-gallery-${i}`;
    return [
      { event: "session-entry", index: 2 + i * 2, entry: call(id, "mcp__yaah-ui__ui_render", "other", "in_progress", input) },
      {
        event: "session-entry",
        index: 3 + i * 2,
        entry: { type: "ui", askId: null, answer: null, title, component: null, version: null, tree, props: {} },
      },
      { event: "session-entry", index: 2 + i * 2, entry: call(id, "mcp__yaah-ui__ui_render", "other", "completed", input, "Rendered.") },
    ];
  }),
  { event: "session-info", running: false, stopReason: "end_turn" },
];

/** A short message, then one rendered card per entry (the map types and flow graphs mocks). */
function cardsRecording(text: string, prefix: string, entries: [string, Record<string, unknown>][]): Recording {
  return [
    { event: "session-info", running: true, stopReason: null },
    { event: "session-entry", index: 0, entry: { type: "user", text: "", attachments: [] } },
    { event: "session-entry", index: 1, entry: { type: "agent", text, messageId: null } },
    ...entries.flatMap(([title, tree], i): Recording => {
      const input = { title, tree };
      const id = `${prefix}-${i}`;
      return [
        { event: "session-entry", index: 2 + i * 2, entry: call(id, "mcp__yaah-ui__ui_render", "other", "in_progress", input) },
        {
          event: "session-entry",
          index: 3 + i * 2,
          entry: { type: "ui", askId: null, answer: null, title, component: null, version: null, tree, props: {} },
        },
        { event: "session-entry", index: 2 + i * 2, entry: call(id, "mcp__yaah-ui__ui_render", "other", "completed", input, "Rendered.") },
      ];
    }),
    { event: "session-info", running: false, stopReason: "end_turn" },
  ];
}
/** "map types": the region map kinds (map-types.ts). */
const mapTypesRecording = cardsRecording(
  "Ten maps: a world choropleth, US states by 2024 margin, European store revenue as bubbles, edge locations as an outline, flights and data-centre traffic as connections, weather stations as a hexbin, Iberia zoomed in, a delivery round and bike docks on the street map. Numbers are illustrative.",
  "map-types",
  mapTypes,
);
/** "flow graphs": a CI sankey and a service network (flow-graphs.ts). */
const flowGraphsRecording = cardsRecording(
  "Three flow graphs: last week's CI runs as a sankey, the service call graph as a network, and the monorepo's package imports. Numbers are made up.",
  "flow-graphs",
  flowGraphs,
);

/** Which recording answers a prompt: the first pattern it matches, else the permission chat. */
const routes: [RegExp, readonly MockStep[]][] = [
  // `ui_open_pane` (only when the user asks): a diff, or a UI moved out of the chat.
  [/(diff|changes) (in|into) a (side )?pane|open (a |the )?diff (pane|beside|next to)/i, sidePaneDiff],
  [/side pane|pin (it|that|them|the deploys)|move (it|that) (in)?to a pane/i, sidePaneUi],
  [/command output|tool cards/i, commandOutput],
  [/election (dashboard|night)/i, election],
  [/chart gallery/i, gallery],
  [/map gallery/i, mapGalleryRecording],
  [/map types/i, mapTypesRecording],
  [/flow graphs?/i, flowGraphsRecording],
  [/diff of my project|workspace of yaah|request folders/i, folderRequest],
  [/big diff/i, bigDiff],
  [/screenshot|browser/i, screenshotChat],
  [/expand fill/i, expandFill],
  [/assembl|deploys/i, assembling],
  [/\bmdx\b|docs page/i, mdxReply],
  [/\blinks?\b|markdown/i, markdownReply],
  [/notices|mcp servers?\b/i, notices],
  [/\btriage\b|auto-allow/i, permissionsReply],
  [/saved results?|web search/i, savedResultsReply],
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
  // Messages sent while a turn runs (session/queue.rs): queued, then sent as turns end.
  const queue = mockQueue(m, {
    send: (sid, item) =>
      void replay(sid, item.text, item.mentions ?? [], item.files ?? []).catch((e: unknown) => console.error("[browser-mock] replay failed", e)),
    cancel: (sid) => cancelTurn(sid),
  });

  /** Notices added mid-turn (folders added), shown once the turn ends. */
  const afterTurn: Record<string, Entry[]> = {};
  const flushAfterTurn = async (sessionId: string) => {
    for (const notice of afterTurn[sessionId]?.splice(0) ?? []) await show(sessionId, (state.transcripts[sessionId] ??= []).length, notice);
  };

  /** Replays the recording for `text`, after what the chat already shows. */
  async function replay(sessionId: string, text: string, mentions: string[], files: Attachment[] = []) {
    const s = session(sessionId);
    stopTurn(state.turns[sessionId]);
    const turn: Turn = { cancelled: false, answered: new Set() };
    state.turns[sessionId] = turn;
    const pause = () => new Promise<void>((resume) => (turn.resume = resume));

    // After switch_agent the first prompt carries the conversation to the new agent (shown as an attachment).
    const handoff = s.handoffFrom;
    delete s.handoffFrom;
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
      if (step.event === "ui-open-pane") {
        await m.wait(350);
        const c = step.content;
        const content =
          c.kind === "ui" ? { kind: "ui", chat: sessionId, index: offset + c.index } : { kind: "diff", cwd: s.cwd, mode: c.mode ?? "all" };
        await m.emit("ui-open-pane", { sessionId, direction: step.direction ?? "right", content });
        continue;
      }
      if (step.event === "session-info") {
        // A recording can open with the chat as it was created (not running); this turn already runs.
        if (!step.running && rendered.size === 0 && step === recording[0]) continue;
        // Keep the mock's own record in step, so e.g. a rename mid-turn doesn't look stopped.
        Object.assign(s, { running: step.running, stopReason: step.stopReason });
        if (!step.running) await flushAfterTurn(sessionId);
        await showInfo(s);
        if (!step.running) queue.turnEnded(sessionId, step.stopReason);
        continue;
      }
      const index = offset + step.index;
      // The user's own prompt replaces the recorded one (later recorded prompts stay).
      const entry: Entry =
        step === firstUser && step.entry.type === "user"
          ? {
              ...step.entry,
              text,
              attachments: [...(handoff ? [`hand-off from ${handoff}`] : []), ...mentions.map(baseName)],
              ...(files.length ? { files } : {}),
              ...referenceEntry(state, text),
            }
          : step.entry;
      const isUpdate = entry.type === "ui" && rendered.has(index);
      if (entry.type === "ui") rendered.add(index);
      // The click supplies the permission choice and the form answer; skip the recorded ones
      // (but not what session/permissions.rs answered itself, which is shown, marked).
      if (entry.type === "permission" && entry.chosen != null && !entry.auto) continue;
      if (entry.type === "ui" && entry.answer != null && turn.answered.has(index)) continue;
      // In-place UI updates (e.g. a sub-agent panel) wait a while, as the real work did.
      await m.wait(isUpdate ? 6000 : entry.type === "agent" ? 120 : 350);
      if (turn.cancelled) return;
      // A request for a server the user already trusts is answered without asking, as session.rs does.
      const trusted = entry.type === "permission" ? trustedAnswer(entry, trustedFor(s, state)) : null;
      await show(sessionId, index, trusted ?? (entry.type === "ui" ? shiftTimes(entry, shift) : entry));
      if ((entry.type === "permission" && entry.chosen == null && !trusted) || (entry.type === "ui" && entry.askId && entry.answer == null))
        await pause();
      if (entry.type === "folderRequest" && entry.answer == null) {
        await pause();
        const answered = shown(sessionId, index);
        // "Not now": the agent carries on without the folder (and doesn't go looking for it).
        if (!turn.cancelled && answered?.type === "folderRequest" && answered.answer !== "added") {
          await show(sessionId, state.transcripts[sessionId]?.length ?? index + 1, {
            type: "agent",
            text: "OK, I'll leave that folder out of this chat.",
            messageId: null,
          });
          Object.assign(s, { running: false, stopReason: "end_turn" });
          await flushAfterTurn(sessionId);
          await showInfo(s);
          queue.turnEnded(sessionId, "end_turn");
          return;
        }
      }
    }
  }

  // What session.rs reports while a chat starts: the agent, then session/new with its MCP servers.
  const starting = async (startId?: string) => {
    if (!startId) return;
    await m.emit("session-starting", { startId, stage: "agent", servers: [] });
    await m.wait(700);
    await m.emit("session-starting", { startId, stage: "mcpServers", servers: ["chrome-devtools", "fetch"] });
    await m.wait(900);
  };

  // session.rs `add_dirs`: a project chat's repos join the project (every chat in it follows), a quick chat keeps them;
  // the notice waits for a running turn to end there, here it shows at once.
  const addDirs = async (sessionId: string, paths: string[]): Promise<SessionInfo> => {
    const s = session(sessionId);
    const added = [...new Set(paths.map((p) => p.replace(/(.)\/+$/, "$1")))].filter((p) => p !== s.cwd && !s.additionalDirs.includes(p));
    if (!added.length) return s;
    const project = s.projectId ? state.projects.find((p) => p.id === s.projectId) : undefined;
    if (project) {
      project.dirs = [...new Set([...project.dirs, ...added])];
      await m.emit("projects-changed", { projectId: project.id });
      for (const c of Object.values(state.sessions).filter((c) => c.projectId === project.id)) {
        const dirs = [...new Set([...project.dirs, project.contextDir, ...c.extraDirs])].filter((d) => d !== c.cwd);
        Object.assign(c, { additionalDirs: dirs, dirsChanged: true });
        if (c !== s) await showInfo(c);
      }
    } else Object.assign(s, { additionalDirs: [...s.additionalDirs, ...added], extraDirs: [...s.extraDirs, ...added], dirsChanged: true });
    const notice: Entry = { type: "addedDirs", paths: added, to: project ? "project" : "chat" };
    // Mid-turn the notice waits for the turn to end, as session.rs `after_turn` does.
    if (s.running) (afterTurn[sessionId] ??= []).push(notice);
    else await show(sessionId, (state.transcripts[sessionId] ??= []).length, notice);
    await showInfo(s);
    return s;
  };

  /** `cancel_turn`: the replay stops; a queue waiting on it pauses (or Send now's message goes). */
  async function cancelTurn(sessionId: string) {
    const s = session(sessionId);
    if (s.running) queue.stopped(sessionId);
    stopTurn(state.turns[sessionId]);
    await flushAfterTurn(sessionId);
    await showInfo(Object.assign(s, { running: false, stopReason: "cancelled" }));
    queue.turnEnded(sessionId, "cancelled");
  }

  return {
    list_sessions: (): SessionInfo[] => Object.values(state.sessions),
    // `extraDirs` (docs/research/chat-repos-contract.md): a project's join the project; a quick chat's are its own.
    new_session: async ({
      projectId,
      accountId,
      extraDirs = [],
      startId,
    }: {
      projectId: string;
      accountId: string;
      extraDirs?: string[];
      startId?: string;
    }): Promise<SessionInfo> => {
      await starting(startId);
      const p = need(
        state.projects.find((x) => x.id === projectId),
        `no project ${projectId}`,
      );
      p.dirs = [...new Set([...p.dirs, ...extraDirs])];
      return Object.assign(openProjectChat(m, p, accountId), { extraDirs: [] as string[] });
    },
    new_quick_chat: async ({
      accountId,
      dir,
      extraDirs = [],
      startId,
    }: {
      accountId: string;
      dir: string | null;
      extraDirs?: string[];
      startId?: string;
    }): Promise<SessionInfo> => {
      await starting(startId);
      const cwd = dir ?? `${home}/.yaah/scratch/3f9c2a7e41d0`;
      const extra = [...new Set(extraDirs)].filter((d) => d !== cwd);
      return Object.assign(open({ projectId: null, accountId, cwd, additionalDirs: extra }), { extraDirs: extra });
    },
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

    send_prompt: async ({
      sessionId,
      text,
      mentions = [],
      attachments = [],
    }: {
      sessionId: string;
      text: string;
      mentions?: string[];
      attachments?: string[];
    }) => {
      const s = session(sessionId);
      // What the composer attached, as attachments.rs sends it for this agent.
      const files = takeStaged(m, attachments, state.profiles.find((p) => p.id === s.accountId)?.report);
      const queued = queue.ifBusy(s, text, mentions, files);
      if (queued) return queued;
      // references.rs reads the message's `github#…` tokens before the turn starts.
      if (referencesIn(state, text).length) await m.wait(400);
      if (!state.transcripts[sessionId]?.length) s.title = (text.split("\n")[0] ?? "").slice(0, 60);
      // The turn runs on after the command returns, as in Rust, where the chat is running from here on
      // (so a message sent before the recording's first step queues rather than replacing this turn).
      s.running = true;
      replay(sessionId, text, mentions, files).catch((e: unknown) => console.error("[browser-mock] replay failed", e));
      return { status: "started" };
    },
    // session.rs `switch_agent`: the next prompt goes to another agent (a fresh session there, with a hand-off).
    switch_agent: async ({ sessionId, accountId }: { sessionId: string; accountId: string }): Promise<SessionInfo> => {
      const s = session(sessionId);
      if (s.running) throw new Error("Wait for the turn to end (or stop it) before switching agents.");
      const label = (id: string) => state.profiles.find((p) => p.id === id)?.label;
      const to = need(label(accountId), `unknown agent ${accountId}; add it again in Manage agents`);
      if (accountId === s.accountId) throw new Error(`This chat already uses ${to}.`);
      const from = label(s.accountId) ?? null;
      // The new agent's settings (Rust learns them from its fresh session on the next message).
      Object.assign(s, { accountId, handoffFrom: from ?? s.accountId, config: initialConfig(state, accountId) });
      const list = (state.transcripts[sessionId] ??= []);
      await show(sessionId, list.length, { type: "switch", accountId, label: to, from });
      await showInfo(s);
      return s;
    },
    add_chat_dirs: ({ sessionId, paths }: { sessionId: string; paths: string[] }) => addDirs(sessionId, paths),
    // session.rs `answer_folders`: Add goes through the add-repos flow (add_chat_dirs), then the waiting agent hears it.
    answer_folder_request: async ({ sessionId, index, add }: { sessionId: string; index: number; add: boolean }): Promise<SessionInfo> => {
      const request = shown(sessionId, index);
      if (request?.type !== "folderRequest") throw new Error("no folder request at that index");
      if (request.answer != null) throw new Error("this request was already answered");
      if (add) await addDirs(sessionId, request.paths);
      await show(sessionId, index, { ...request, answer: add ? "added" : "declined" });
      state.turns[sessionId]?.resume?.();
      return session(sessionId);
    },
    respond_permission: async ({ sessionId, index, optionId }: { sessionId: string; index: number; optionId: string | null }) => {
      const request = shown(sessionId, index);
      if (request?.type !== "permission") throw new Error("no permission request at that index");
      const option = request.options.find((o) => o.optionId === optionId);
      await show(sessionId, index, { ...request, chosen: option?.name ?? "cancelled", answer: option?.kind ?? "cancelled" });
      state.turns[sessionId]?.resume?.();
      return null;
    },
    // session/trust.rs `trust_server`: in this chat, its project, quick chats or all chats; this request is answered.
    trust_mcp_server: async ({ sessionId, index, scope }: { sessionId: string; index: number; scope?: TrustScope }) => {
      const s = session(sessionId);
      const request = shown(sessionId, index);
      if (request?.type !== "permission") throw new Error("no permission request at that index");
      const server = request.mcpServer;
      if (!server) throw new Error("yaah can't tell which MCP server this request is for");
      const view = trustView(s, state);
      const where = scope ?? view.here;
      if (!view.offered.includes(where)) throw new Error(`this chat can't trust a server ${SCOPE_WORDS[where]}`);
      const add = (list: string[] | undefined) => [...new Set([...(list ?? []), server.id])];
      const project = s.projectId ? state.projects.find((p) => p.id === s.projectId) : undefined;
      if (where === "project" && project) {
        project.trustedMcpServers = add(project.trustedMcpServers);
        await m.emit("projects-changed", { projectId: project.id });
      } else if (where === "quickChats") state.quickTrusted = add(state.quickTrusted);
      else if (where === "everywhere") state.trustedEverywhere = add(state.trustedEverywhere);
      else {
        s.trustedMcpServers = add(s.trustedMcpServers);
        await showInfo(s);
      }
      await m.emit("trust-changed", {});
      const answered = trustedAnswer(request, trustedFor(s, state));
      if (answered) {
        await show(sessionId, index, answered);
        state.turns[sessionId]?.resume?.();
      }
      return null;
    },
    trust_scope: ({ sessionId }: { sessionId: string }) => trustView(session(sessionId), state),
    untrust_chat_mcp_server: async ({ sessionId, server }: { sessionId: string; server: string }): Promise<SessionInfo> => {
      const s = session(sessionId);
      s.trustedMcpServers = (s.trustedMcpServers ?? []).filter((t) => t !== server);
      if (scopeOf(s) === "quickChats") state.quickTrusted = state.quickTrusted.filter((t) => t !== server);
      await showInfo(s);
      await m.emit("trust-changed", {});
      return s;
    },
    untrust_quick_chat_mcp_server: async ({ server }: { server: string }) => {
      state.quickTrusted = state.quickTrusted.filter((t) => t !== server);
      await m.emit("trust-changed", {});
      return null;
    },
    untrust_mcp_server_everywhere: async ({ server }: { server: string }) => {
      state.trustedEverywhere = state.trustedEverywhere.filter((t) => t !== server);
      await m.emit("trust-changed", {});
      return {
        trustReadOnly: state.trustReadOnly,
        allowWebSearch: state.allowWebSearch,
        trustedEverywhere: state.trustedEverywhere.map((id) => ({ id, label: id.replace(/^claude_ai_(?=.)/, "") })),
      };
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
      await cancelTurn(sessionId);
      return null;
    },
    ...queue.replies,
  };
}
