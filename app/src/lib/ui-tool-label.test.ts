import { describe, expect, it } from "vitest";
import { sourceLabel, toolLabel, treeSummary, type ToolStatus } from "@/lib/ui-tool-label";

const ui = (tool: string) => `mcp__yaah-ui__${tool}`;
const label = (title: string, status: ToolStatus, rawInput: unknown = {}, output?: string) => toolLabel({ title, status, rawInput, output });
const text = (title: string, status: ToolStatus, rawInput: unknown = {}, output?: string) => label(title, status, rawInput, output)?.text;

const tabsTree = {
  type: "card",
  props: { title: "Cities" },
  children: [
    { type: "heading", props: { text: "Top 20" } },
    {
      type: "tabs",
      children: [
        { type: "tab", children: [{ type: "table" }] },
        { type: "tab", children: [{ type: "map" }] },
      ],
    },
    { type: "stack", children: [{ type: "map" }, { type: "table" }, { type: "chart" }] },
  ],
};

describe("yaah's UI tools", () => {
  it("ui_catalog and ui_guide say what they read", () => {
    expect(label(ui("ui_catalog"), "in_progress")).toEqual({ text: "Reading yaah's UI catalog", busy: true });
    expect(label(ui("ui_catalog"), "completed")).toEqual({ text: "Read the UI catalog", busy: false });
    expect(text(ui("ui_guide"), "pending")).toBe("Reading yaah's UI guide");
    expect(text(ui("ui_guide"), "completed")).toBe("Read yaah's UI guide");
  });

  it("ui_get_component names the component", () => {
    expect(text(ui("ui_get_component"), "in_progress", { name: "pr-view" })).toBe("Reading the pr-view component");
    expect(text(ui("ui_get_component"), "completed", { name: "pr-view" })).toBe("Read the pr-view component");
    expect(text(ui("ui_get_component"), "failed", { name: "pr-view" })).toBe("Couldn't read the pr-view component");
  });

  it("ui_render builds its title (or component) with a summary of what's in it, then says it rendered it", () => {
    expect(label(ui("ui_render"), "pending", {})).toEqual({ text: "Building the UI…", busy: true });
    expect(label(ui("ui_render"), "in_progress", { title: "Cities" })).toEqual({ text: "Building Cities", busy: true });
    expect(label(ui("ui_render"), "in_progress", { title: "Cities", tree: tabsTree })).toEqual({
      text: "Building Cities",
      detail: "tabs, table, map, chart",
      busy: true,
    });
    expect(label(ui("ui_render"), "completed", { title: "Cities", tree: tabsTree })).toEqual({
      text: "Rendered Cities",
      detail: "tabs, table, map, chart",
      busy: false,
    });
    expect(text(ui("ui_render"), "completed", { component: "pr-view", props: {} })).toBe("Rendered pr-view");
    expect(text(ui("ui_render"), "completed", { title: "  " })).toBe("Rendered the UI");
    expect(text(ui("ui_render"), "failed", {})).toBe("Couldn't build the UI");
  });

  it("ui_ask asks you its title", () => {
    expect(label(ui("ui_ask"), "in_progress", { title: "Which plan?" })).toEqual({ text: "Asking you: Which plan?", busy: true });
    expect(text(ui("ui_ask"), "completed", { title: "Which plan?" })).toBe("Asked you: Which plan?");
    expect(text(ui("ui_ask"), "pending", null)).toBe("Asking you…");
  });

  it("ui_set_values and ui_get_values talk about the form", () => {
    expect(text(ui("ui_set_values"), "in_progress", { id: "trip", values: { a: 1 } })).toBe("Filling in trip");
    expect(text(ui("ui_set_values"), "completed", { id: "trip" })).toBe("Filled in trip");
    expect(text(ui("ui_get_values"), "in_progress", { id: "trip" })).toBe("Reading your answers");
    expect(text(ui("ui_get_values"), "completed", { id: "trip" })).toBe("Read your answers");
  });

  it("ui_request_folders names the folder it asks to add", () => {
    const yaah = { paths: ["/Users/dev/Documents/workspace/yaah"], reason: "to review its diff" };
    expect(label(ui("ui_request_folders"), "in_progress", yaah)).toEqual({ text: "Asking to add ~/Documents/workspace/yaah", busy: true });
    expect(text(ui("ui_request_folders"), "completed", yaah)).toBe("Asked to add ~/Documents/workspace/yaah");
    expect(text(ui("ui_request_folders"), "completed", { paths: ["/a", "/b"] })).toBe("Asked to add 2 folders");
    expect(text(ui("ui_request_folders"), "failed", {})).toBe("Couldn't ask to add folders");
  });

  it("ui_save_component stores the component, then names the version it got", () => {
    expect(label(ui("ui_save_component"), "in_progress", { name: "deploy-card" })).toEqual({ text: "Storing deploy-card", busy: true });
    expect(text(ui("ui_save_component"), "completed", { name: "deploy-card" }, "Saved `deploy-card` v3 to the library.")).toBe(
      "Stored deploy-card v3",
    );
    expect(text(ui("ui_save_component"), "completed", { name: "deploy-card" })).toBe("Stored deploy-card");
    expect(text(ui("ui_save_component"), "failed", { name: "deploy-card" })).toBe("Couldn't store deploy-card");
  });

  it("works with the bare tool names other agents show", () => {
    expect(text("ui_render", "completed", { title: "Deploys" })).toBe("Rendered Deploys");
    expect(text("source_read", "in_progress", { source: { kind: "git.status" } })).toBe("Reading git status");
  });
});

describe("source_read", () => {
  const read = (source: unknown, status: ToolStatus = "in_progress") => text(ui("source_read"), status, { source });

  it("names what it reads", () => {
    expect(read({ kind: "github.pr", repo: "acme/api", number: 12 })).toBe("Reading GitHub PR acme/api#12");
    expect(read({ kind: "github.pr", repo: "acme/api", number: 12 }, "completed")).toBe("Read GitHub PR acme/api#12");
    expect(read({ kind: "github.pr.diff", repo: "acme/api", number: 12 })).toBe("Reading the diff of GitHub PR acme/api#12");
    expect(read({ kind: "github.prs", repo: "acme/api" })).toBe("Listing GitHub PRs in acme/api");
    expect(read({ kind: "gitlab.issue", project: "group/app", iid: 7 })).toBe("Reading GitLab issue group/app#7");
    expect(read({ kind: "linear.issue", id: "ENG-142" })).toBe("Reading Linear issue ENG-142");
    expect(read({ kind: "postgres.query", connection: "shop", sql: "select 1" })).toBe("Querying shop");
    expect(read({ kind: "postgres.query", connection: "shop" }, "completed")).toBe("Queried shop");
    expect(read({ kind: "postgres.schema", connection: "shop" })).toBe("Reading the schema of shop");
    expect(read({ kind: "git.diff", range: "main...HEAD" })).toBe("Reading git diff main...HEAD");
    expect(read({ kind: "git.diff" })).toBe("Reading git diff of the working tree");
    expect(read({ kind: "git.log", range: "v1..HEAD" }, "completed")).toBe("Read git log v1..HEAD");
    expect(read({ kind: "docker.logs", container: "api" })).toBe("Reading Docker logs of api");
    expect(read({ kind: "docker.containers" })).toBe("Listing Docker containers");
    expect(read({ kind: "system" })).toBe("Reading this machine's stats");
    expect(read({ kind: "something.new" })).toBe("Reading something.new");
    expect(read(undefined)).toBe("Reading a source");
  });

  it("says what it couldn't read", () => {
    expect(read({ kind: "postgres.query", connection: "shop" }, "failed")).toBe("Couldn't query shop");
    expect(read({ kind: "github.prs", repo: "acme/api" }, "failed")).toBe("Couldn't list GitHub PRs in acme/api");
    expect(read(undefined, "failed")).toBe("Couldn't read a source");
  });

  it("is a plain function of the source and tense", () => {
    expect(sourceLabel({ kind: "git.show", rev: "abc123" }, (_, done) => done)).toBe("Read git show abc123");
  });
});

describe("ToolSearch", () => {
  it("loading yaah's UI tools", () => {
    expect(label("ToolSearch", "in_progress", { query: "select:mcp__yaah-ui__ui_catalog,mcp__yaah-ui__ui_render" })).toEqual({
      text: "Loading yaah's UI tools",
      busy: false,
    });
    expect(text("ToolSearch", "completed", { query: "yaah-ui", max_results: 10 })).toBe("Loaded yaah's UI tools");
  });

  it("anything else: the query", () => {
    expect(text("ToolSearch", "in_progress", { query: "notebook jupyter" })).toBe("Looking up tools: notebook jupyter");
    expect(text("ToolSearch", "completed", { query: "slack send" })).toBe("Looked up tools: slack send");
    expect(text("ToolSearch", "pending", {})).toBe("Looking up tools");
  });
});

describe("other MCP servers' tools", () => {
  it("server: tool and the main argument", () => {
    expect(text("mcp__fetch__fetch", "completed", { url: "https://www.example.com/page/", max_length: 5000 })).toBe("fetch: example.com/page");
    expect(text("mcp__github__get_pull_request", "in_progress", { repo: "acme/api", number: 12 })).toBe("github: get pull request acme/api");
    expect(text("mcp__linear__list_issues", "completed", {})).toBe("linear: list issues");
    expect(text("mcp__vitro__navigate", "completed", { session_id: "s1", url: "http://localhost:1420" })).toBe("vitro: navigate localhost:1420");
    expect(label("mcp__fetch__fetch", "in_progress", {})?.busy).toBe(false);
  });

  it("long arguments are cut short", () => {
    const t = text("mcp__search__query", "completed", { query: "x".repeat(200) }) ?? "";
    expect(t.length).toBeLessThan(80);
    expect(t.endsWith("…")).toBe(true);
  });
});

it("leaves the agent's own titles alone", () => {
  expect(label("Read /tmp/notes.md", "completed")).toBeNull();
  expect(label("git diff main...HEAD", "completed", { command: "git diff main...HEAD" })).toBeNull();
  expect(label("Fetch https://example.com", "completed")).toBeNull();
});

describe("treeSummary", () => {
  it("looks through layout, skips plain text, dedupes and stops at four", () => {
    expect(treeSummary(tabsTree)).toBe("tabs, table, map, chart");
    expect(treeSummary({ type: "stack", children: [{ type: "stat" }, { type: "stat" }, { type: "chart" }] })).toBe("stat, chart");
    expect(treeSummary({ type: "grid", children: ["stat", "chart", "table", "map", "diagram", "json"].map((type) => ({ type })) })).toBe(
      "stat, chart, table, map +2",
    );
    expect(treeSummary({ type: "card", children: [{ type: "text" }] })).toBeNull();
    expect(treeSummary({ type: "live", props: { source: { kind: "system" } }, children: [{ type: "progress" }] })).toBe("progress");
    expect(treeSummary(undefined)).toBeNull();
    expect(treeSummary({ type: "diff-review", props: { range: "main...HEAD" } })).toBe("diff-review");
  });
});
