// How a chat card names a tool call, from its title and input (`rawInput`): in the present
// tense while it runs ("Building Deploys"), in the past once it's done ("Rendered Deploys").
// yaah's own UI tools, `source_read`, ToolSearch and other MCP servers' tools get words;
// everything else (Read, shell commands…) keeps the title the agent gave it (`null` here).

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed" | null;

export type ToolCallLike = {
  title: string;
  status: ToolStatus;
  rawInput: unknown;
  /** The text the tool returned, if any (e.g. `Saved \`x\` v3 to the library.`). */
  output?: string;
};

export type ToolLabel = {
  text: string;
  /** Secondary text: what a UI holds ("tabs, map, table"). */
  detail?: string;
  /** One of yaah's UI tools, still running: the card shows a spinner and the time so far. */
  busy: boolean;
};

/** MCP tools arrive as `mcp__<server>__<tool>` (Claude Code) or with the bare tool name (others). */
const MCP = /^mcp__(.+?)__(.+)$/;
const UI_SERVER = "yaah-ui";
const UI_TOOLS = new Set([
  "ui_catalog",
  "ui_guide",
  "ui_get_component",
  "ui_render",
  "ui_ask",
  "ui_get_values",
  "ui_set_values",
  "ui_save_component",
  "source_read",
]);

type Input = Record<string, unknown>;
const asInput = (v: unknown): Input => (v && typeof v === "object" && !Array.isArray(v) ? (v as Input) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

/** Present or past, by whether the call still runs. */
type Tense = (now: string, done: string) => string;

export function toolLabel(call: ToolCallLike): ToolLabel | null {
  const title = call.title.trim();
  const running = call.status === "pending" || call.status === "in_progress";
  const failed = call.status === "failed";
  const tense: Tense = (now, done) => (running ? now : done);
  const input = asInput(call.rawInput);

  const m = MCP.exec(title);
  const [server, tool] = m ? [m[1], m[2]] : [null, title];
  if ((server === UI_SERVER || (server == null && UI_TOOLS.has(tool))) && UI_TOOLS.has(tool)) {
    const label = uiLabel(tool, input, call.output, tense, failed);
    return { ...label, busy: running };
  }
  if (title === "ToolSearch") {
    const query = str(input.query);
    if (query && /yaah[-_ ]?ui/i.test(query)) return { text: tense("Loading yaah's UI tools", "Loaded yaah's UI tools"), busy: false };
    return {
      text: query ? `${tense("Looking up tools", "Looked up tools")}: ${clip(query, 60)}` : tense("Looking up tools", "Looked up tools"),
      busy: false,
    };
  }
  if (server) {
    const arg = mainArgument(input);
    const name = tool === server ? "" : tool.replace(/_/g, " ");
    return { text: [`${server}:`, name, arg].filter(Boolean).join(" "), busy: false };
  }
  return null;
}

function uiLabel(tool: string, input: Input, output: string | undefined, tense: Tense, failed: boolean): Omit<ToolLabel, "busy"> {
  switch (tool) {
    case "ui_catalog":
      return { text: failed ? "Couldn't read the UI catalog" : tense("Reading yaah's UI catalog", "Read the UI catalog") };
    case "ui_guide":
      return { text: failed ? "Couldn't read yaah's UI guide" : tense("Reading yaah's UI guide", "Read yaah's UI guide") };
    case "ui_get_component": {
      const name = str(input.name);
      if (failed) return { text: name ? `Couldn't read the ${name} component` : "Couldn't read a component" };
      return { text: name ? `${tense("Reading", "Read")} the ${name} component` : tense("Reading a component", "Read a component") };
    }
    case "ui_render": {
      const name = str(input.title) ?? str(input.component);
      const detail = treeSummary(input.tree) ?? undefined;
      if (failed) return { text: name ? `Couldn't build ${name}` : "Couldn't build the UI", detail };
      return { text: name ? `${tense("Building", "Rendered")} ${name}` : tense("Building the UI…", "Rendered the UI"), detail };
    }
    case "ui_ask": {
      const name = str(input.title) ?? str(input.component);
      if (failed) return { text: "Couldn't ask you" };
      return {
        text: name ? `${tense("Asking you", "Asked you")}: ${name}` : tense("Asking you…", "Asked you"),
        detail: treeSummary(input.tree) ?? undefined,
      };
    }
    case "ui_set_values": {
      const id = str(input.id);
      if (failed) return { text: id ? `Couldn't fill in ${id}` : "Couldn't fill in the form" };
      return { text: `${tense("Filling in", "Filled in")} ${id ?? "the form"}` };
    }
    case "ui_get_values":
      return { text: failed ? "Couldn't read your answers" : tense("Reading your answers", "Read your answers") };
    case "ui_save_component": {
      const name = str(input.name) ?? "a component";
      if (failed) return { text: `Couldn't store ${name}` };
      const version = /\bv(\d+)\b/.exec(output ?? "")?.[1];
      return { text: tense(`Storing ${name}`, version ? `Stored ${name} v${version}` : `Stored ${name}`) };
    }
    default:
      return { text: sourceLabel(asInput(input.source), failed ? (now) => now.replace(/^\w+/, (w) => VERB_FAILED[w] ?? w) : tense) };
  }
}

/** "Reading" → "Couldn't read", for a `source_read` that failed. */
const VERB_FAILED: Record<string, string> = { Reading: "Couldn't read", Listing: "Couldn't list", Querying: "Couldn't query" };

/** What `source_read` reads, e.g. "Reading GitHub PR acme/api#12", "Querying shop", "Reading git diff main...HEAD". */
export function sourceLabel(source: Input, tense: Tense): string {
  const kind = str(source.kind) ?? "";
  const read = tense("Reading", "Read");
  const list = tense("Listing", "Listed");
  const ref = (owner: unknown, n: unknown) => [str(owner), str(n)].filter(Boolean).join("#");
  switch (kind) {
    case "github.pr":
      return `${read} GitHub PR ${ref(source.repo, source.number)}`.trim();
    case "github.pr.diff":
      return `${read} the diff of GitHub PR ${ref(source.repo, source.number)}`.trim();
    case "github.prs":
      return `${list} GitHub PRs${str(source.repo) ? ` in ${str(source.repo)}` : ""}`;
    case "github.issue":
      return `${read} GitHub issue ${ref(source.repo, source.number)}`.trim();
    case "github.issues":
      return `${list} GitHub issues${str(source.repo) ? ` in ${str(source.repo)}` : ""}`;
    case "gitlab.issue":
      return `${read} GitLab issue ${ref(source.project, source.iid)}`.trim();
    case "gitlab.issues":
      return `${list} GitLab issues${str(source.project) ? ` in ${str(source.project)}` : ""}`;
    case "linear.issue":
      return `${read} Linear issue ${str(source.id) ?? ""}`.trim();
    case "linear.issues":
      return `${list} Linear issues${str(source.team) ? ` of ${str(source.team)}` : ""}`;
    case "linear.project":
    case "linear.board":
    case "linear.cycle":
      return `${read} the Linear ${kind.slice(7)}${str(source.id) ? ` ${str(source.id)}` : ""}`;
    case "postgres.query":
      return `${tense("Querying", "Queried")} ${str(source.connection) ?? "the database"}`;
    case "postgres.schema":
      return `${read} the schema of ${str(source.connection) ?? "the database"}`;
    case "git.diff":
      return `${read} git diff ${str(source.range) ?? (source.staged === true ? "--staged" : "of the working tree")}`;
    case "git.log":
      return `${read} git log${str(source.range) ? ` ${str(source.range)}` : ""}`;
    case "git.status":
      return `${read} git status`;
    case "git.show":
      return `${read} git show ${str(source.rev) ?? ""}`.trim();
    case "docker.containers":
      return `${list} Docker containers`;
    case "docker.stats":
      return `${read} Docker stats${str(source.container) ? ` of ${str(source.container)}` : ""}`;
    case "docker.logs":
      return `${read} Docker logs${str(source.container) ? ` of ${str(source.container)}` : ""}`;
    case "system":
      return `${read} this machine's stats`;
    default:
      return kind ? `${read} ${kind}` : tense("Reading a source", "Read a source");
  }
}

/** Layout nodes looked through when summarising a UI: what they hold is what's worth naming. */
const LAYOUT = new Set(["stack", "grid", "card", "live", "collapsible", "tab"]);
/** Named, and looked through too: tabs of a map and a table read "tabs, map, table". */
const SECTIONS = new Set(["tabs"]);
/** Too plain to name. */
const PLAIN = new Set(["heading", "text", "separator", "markdown", "badge"]);
const SUMMARY_MAX = 4;

/** The kinds of things a UI tree shows, e.g. "tabs, map, table": its top-level primitives, deduped. */
export function treeSummary(tree: unknown): string | null {
  const found: string[] = [];
  const walk = (node: unknown, depth: number) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth));
    const n = asInput(node);
    const type = str(n.type) ?? (str(n.$component) ? str(n.$component) : null);
    if (!type) return;
    if (LAYOUT.has(type) && depth < 6) return walk(n.children, depth + 1);
    if (!PLAIN.has(type) && !found.includes(type)) found.push(type);
    if (SECTIONS.has(type) && depth < 6) walk(n.children, depth + 1);
  };
  walk(tree, 0);
  if (!found.length) return null;
  const extra = found.length - SUMMARY_MAX;
  return found.slice(0, SUMMARY_MAX).join(", ") + (extra > 0 ? ` +${extra}` : "");
}

/** An MCP call's main argument, short: a URL without its scheme, else a query, path, name or id. */
function mainArgument(input: Input): string | null {
  for (const key of ["url", "query", "q", "path", "file", "name", "id", "repo", "command", "sql", "prompt", "text"]) {
    const v = str(input[key]);
    if (v) return clip(key === "url" ? v.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") : v, 60);
  }
  const first = Object.values(input).map(str).find(Boolean);
  return first ? clip(first, 60) : null;
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
