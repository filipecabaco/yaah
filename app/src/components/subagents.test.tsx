// Sub-agents: calls nested under the card of the call that launched them (lib/subagents.ts,
// subagent-card.tsx, subagent-strip.tsx).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SubagentCard } from "@/components/subagent-card";
import { SubagentStrip } from "@/components/subagent-strip";
import type { Entry } from "@/lib/api";
import { foldedPermissions } from "@/lib/permissions";
import { agentStatus, resultSummary, stripText, subagentInfo, subagentTree } from "@/lib/subagents";
import { transcriptRows } from "@/lib/tool-groups";

type Tool = Extract<Entry, { type: "tool" }>;
const tool = (id: string, more: Partial<Tool> = {}): Tool => ({
  type: "tool",
  toolCallId: id,
  title: `Read ${id}.rs`,
  kind: "read",
  status: "completed",
  content: [],
  locations: [],
  rawInput: null,
  ...more,
});
const launch = (id: string, more: Partial<Tool> = {}, input: Record<string, unknown> = {}): Tool =>
  tool(id, {
    title: "Explore the repo",
    kind: "think",
    rawInput: { description: "Explore the repo", prompt: "look", subagent_type: "Explore", ...input },
    ...more,
  });
const ask = (id: string, chosen: string | null = null): Entry => ({
  type: "permission",
  requestId: 1,
  toolCallId: id,
  title: id,
  options: [],
  chosen,
});
const rows = (entries: Entry[]) => transcriptRows(entries, 0, foldedPermissions(entries));

describe("recognising a sub-agent", () => {
  it("reads name, type, model and background from the input", () => {
    expect(subagentInfo(launch("a", {}, { model: "haiku", run_in_background: true }))).toEqual({
      name: "Explore the repo",
      type: "Explore",
      model: "haiku",
      background: true,
    });
    expect(subagentInfo(tool("b", { rawInput: { command: "ls" } }))).toBeNull();
    expect(subagentInfo(tool("c"))).toBeNull();
  });

  it("status: running until it ends; a background launch stays so while the turn runs", () => {
    const info = subagentInfo(launch("a"))!;
    expect(agentStatus(launch("a", { status: "in_progress" }), info, true)).toBe("running");
    expect(agentStatus(launch("a"), info, true)).toBe("done");
    expect(agentStatus(launch("a", { status: "failed" }), info, true)).toBe("failed");
    const bg = subagentInfo(launch("a", {}, { run_in_background: true }))!;
    expect(agentStatus(launch("a", {}, { run_in_background: true }), bg, true)).toBe("background");
    expect(agentStatus(launch("a", {}, { run_in_background: true }), bg, false)).toBe("done");
  });

  it("summaries", () => {
    expect(resultSummary("\n## Found it\nmore")).toBe("Found it");
    expect(resultSummary("x".repeat(300))!.length).toBe(140);
    expect(stripText([{ status: "running" }, { status: "running" }, { status: "done" }])).toBe("2 agents running · 1 done");
    expect(stripText([{ status: "done" }])).toBeNull();
  });
});

describe("nesting", () => {
  const entries: Entry[] = [
    launch("L", { status: "in_progress" }),
    tool("a", { parentToolCallId: "L" }),
    tool("b", { parentToolCallId: "L" }),
    ask("b"),
    tool("deep", { parentToolCallId: "a" }),
    tool("top"),
  ];

  it("puts calls made inside it, and requests about them, under its card, nested ones too", () => {
    expect(subagentTree(entries, 0).inside.get(0)).toEqual([1, 2, 3, 4]);
    expect(rows(entries)).toEqual([
      { kind: "agent", index: 0, inside: [1, 2, 3, 4] },
      { kind: "entry", index: 5 },
    ]);
  });

  it("without a link, nothing is nested", () => {
    const plain = [launch("L"), tool("a"), tool("b")];
    expect(rows(plain)).toEqual([
      { kind: "agent", index: 0, inside: [] },
      { kind: "group", indices: [1, 2] },
    ]);
  });
});

describe("the card and the strip", () => {
  const card = (props: Partial<React.ComponentProps<typeof SubagentCard>> = {}) =>
    render(
      <SubagentCard
        id={`s:${Math.random()}`}
        tool={launch("L", { status: "in_progress" })}
        inTurn
        calls={[tool("a", { title: "Read a.rs", rawInput: { file_path: "a.rs" } }), tool("b")]}
        items={[
          { index: 1, waiting: false },
          { index: 2, waiting: false },
        ]}
        card={(i) => <p>inner {i}</p>}
        {...props}
      />,
    );

  it("is collapsed, shows name, status and count; opens to its calls", () => {
    card();
    expect(screen.getByText("Explore the repo")).toBeInTheDocument();
    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
    expect(screen.getByText(/running/)).toBeInTheDocument();
    expect(screen.queryByText("inner 1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Explore the repo/ }));
    expect(screen.getByText("inner 1")).toBeInTheDocument();
  });

  it("keeps a waiting request in sight while closed", () => {
    card({ items: [{ index: 2, waiting: true }] });
    expect(screen.getByText("inner 2")).toBeInTheDocument();
    expect(screen.getByText("needs you")).toBeInTheDocument();
  });

  it("a finished one shows the first line of its answer, not all of it", () => {
    card({
      tool: launch("L", { content: [{ type: "content", content: { type: "text", text: "Found three files.\nDetails follow." } }] }),
      inTurn: false,
    });
    expect(screen.getByText(/Found three files\./)).toBeInTheDocument();
    expect(screen.queryByText(/Details follow/)).toBeNull();
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("the strip counts and is hidden when nothing runs", () => {
    const { container, rerender } = render(
      <SubagentStrip
        agents={[
          { id: "L", name: "Explore", status: "running" },
          { id: "M", name: "Plan", status: "done" },
        ]}
      />,
    );
    expect(screen.getByText("1 agent running · 1 done")).toBeInTheDocument();
    rerender(<SubagentStrip agents={[{ id: "M", name: "Plan", status: "done" }]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("batched permission requests in rows", () => {
  it("two waiting requests make one batch row at the first; one alone does not", () => {
    const two = [tool("a"), ask("a"), tool("b"), ask("b")];
    const r = rows(two);
    expect(r.filter((x) => x.kind === "batch")).toEqual([{ kind: "batch", index: 1, members: [1, 3] }]);
    expect(rows([tool("a"), ask("a")]).some((x) => x.kind === "batch")).toBe(false);
  });

  it("requests inside sub-agent cards are pulled out into the batch, which sits before the first card", () => {
    const entries = [
      launch("L1"),
      launch("L2"),
      tool("c1", { parentToolCallId: "L1" }),
      ask("c1"),
      tool("c2", { parentToolCallId: "L2" }),
      ask("c2"),
    ];
    const r = rows(entries);
    expect(r.map((x) => x.kind)).toEqual(["batch", "agent", "agent"]);
    const agents = r.filter((x) => x.kind === "agent");
    expect(agents.map((a) => a.inside.includes(3) || a.inside.includes(5))).toEqual([false, false]);
    expect(agents.map((a) => a.asking)).toEqual([1, 1]);
  });
});
