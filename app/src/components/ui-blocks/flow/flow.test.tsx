// Flow graphs: input checks before any layout (unknown nodes, self-links, a sankey cycle named),
// the sankey and network layouts (in the box, deterministic), and both drawn for real: names,
// table views, keyboard focus node to node and along links, legends, and the cycle error.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import UiFlow from "@/components/ui-blocks/flow/flow";
import { findCycle, groupSlots, readFlow } from "@/components/ui-blocks/flow/flow-model";
import { bandPath, layoutSankey, placeSankeyLabels } from "@/components/ui-blocks/flow/sankey-layout";
import { fitLayout, layoutNetwork, lcg } from "@/components/ui-blocks/flow/network-layout";

const ci = {
  kind: "sankey",
  unit: " jobs",
  nodes: [
    { id: "push", label: "Push" },
    { id: "lint", label: "Lint" },
    { id: "test", label: "Test" },
    { id: "build", label: "Build" },
    { id: "pass", label: "Passed", tone: "success" },
    { id: "fail", label: "Failed", tone: "danger" },
  ],
  links: [
    { source: "push", target: "lint", value: 120 },
    { source: "push", target: "test", value: 120 },
    { source: "lint", target: "pass", value: 112 },
    { source: "lint", target: "fail", value: 8 },
    { source: "test", target: "build", value: 101 },
    { source: "test", target: "fail", value: 19 },
    { source: "build", target: "pass", value: 101 },
  ],
};

const services = {
  kind: "network",
  nodes: [
    { id: "web", label: "web", group: "edge", size: 3 },
    { id: "api", label: "api", group: "core", size: 5 },
    { id: "auth", label: "auth", group: "core", size: 2 },
    { id: "db", label: "postgres", group: "data", size: 4 },
  ],
  links: [
    { source: "web", target: "api", value: 900 },
    { source: "api", target: "auth", value: 700 },
    { source: "api", target: "db", value: 1500 },
    { source: "auth", target: "db", value: 300 },
  ],
};

describe("input checks", () => {
  it("passes the research examples", () => {
    expect(readFlow(ci).errors).toEqual([]);
    expect(readFlow(services).errors).toEqual([]);
  });

  it("refuses links to unknown nodes, self-links, non-positive sankey values and repeated ids", () => {
    const { errors } = readFlow({
      kind: "sankey",
      nodes: [{ id: "a" }, { id: "b" }, { id: "a" }],
      links: [
        { source: "a", target: "z", value: 1 },
        { source: "b", target: "b", value: 1 },
        { source: "a", target: "b", value: 0 },
      ],
    });
    expect(errors).toEqual([
      'Node "a" is listed twice.',
      'links[0] goes from "a" to "z", but "z" isn\'t a node.',
      'links[1] goes from "b" to itself.',
      "links[2] (a → b) needs a value above 0; a sankey's widths are its values.",
    ]);
  });

  it("names a sankey cycle, node by node, and lets a network loop", () => {
    expect(
      findCycle(
        ["a", "b", "c"],
        [
          { source: "a", target: "b" },
          { source: "b", target: "c" },
          { source: "c", target: "b" },
        ],
      ),
    ).toEqual(["b", "c", "b"]);
    expect(findCycle(["a", "b"], [{ source: "a", target: "b" }])).toBeNull();
    const loop = { ...ci, links: [...ci.links, { source: "build", target: "test", value: 2 }] };
    expect(readFlow(loop).errors[0]).toBe(
      "The links form a cycle (test → build → test); a sankey flows one way. Split the node that repeats into two stages.",
    );
    expect(readFlow({ ...services, links: [...services.links, { source: "db", target: "web" }] }).errors).toEqual([]);
    // A long chain is fine, and doesn't overflow.
    const n = 5000;
    expect(
      findCycle(
        Array.from({ length: n }, (_, i) => `n${i}`),
        Array.from({ length: n - 1 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` })),
      ),
    ).toBeNull();
  });

  it("caps nodes and links per kind and gives groups at most three colours", () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ id: `n${i}` }));
    expect(readFlow({ kind: "sankey", nodes: many, links: [] }).errors[0]).toContain("at most 200 nodes; this one has 201");
    expect(readFlow({ kind: "network", nodes: many, links: [] }).errors).toEqual([]);
    const slots = groupSlots(["a", "b", "a", "c", "d"].map((group, i) => ({ id: String(i), label: "", group, tone: "default" as const })));
    expect([...slots]).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });
});

describe("sankey layout", () => {
  const { flow } = readFlow(ci);

  it("puts sources left and sinks right, inside the box, bands as wide as their values", () => {
    const l = layoutSankey(flow.nodes, flow.links, 600, 300);
    const at = new Map(l.nodes.map((n) => [n.id, n]));
    expect(l.columns).toBe(4);
    expect(at.get("push")!.x0).toBeLessThan(at.get("lint")!.x0);
    expect(at.get("pass")!.x1).toBeCloseTo(599, 0);
    expect(at.get("fail")!.x1).toBeCloseTo(599, 0);
    for (const n of l.nodes) {
      expect(n.y0).toBeGreaterThanOrEqual(0);
      expect(n.y1).toBeLessThanOrEqual(300);
    }
    const band = (s: string, t: string) => l.links.find((b) => b.source === s && b.target === t)!;
    expect(band("lint", "pass").width / band("lint", "fail").width).toBeCloseTo(112 / 8, 1);
    expect(at.get("pass")!.inValue).toBe(213);
    expect(bandPath(0, 10, 100, 50)).toBe("M0,10C50,10 50,50 100,50");
  });

  it("is the same every time for the same input and size", () => {
    expect(layoutSankey(flow.nodes, flow.links, 600, 300)).toEqual(layoutSankey(flow.nodes, flow.links, 600, 300));
  });

  it("places labels beside their node without overlapping, sinks' on their left", () => {
    const l = layoutSankey(flow.nodes, flow.links, 600, 300);
    const labels = placeSankeyLabels(l.nodes, (n) => n.label, 11, 600, 300, l.columns);
    expect(labels.size).toBe(6);
    expect(labels.get("pass")!.anchor).toBe("end");
    expect(labels.get("push")!.anchor).toBe("start");
  });
});

describe("network layout", () => {
  const input = { nodes: services.nodes.map((n) => ({ id: n.id, size: n.size })), links: services.links };

  it("settles the same way every time (phyllotaxis start, seeded jiggle, fixed ticks)", () => {
    const a = layoutNetwork(input);
    expect(layoutNetwork(input)).toEqual(a);
    // Even nodes started on the same spot (where d3 jiggles them with the random source) settle alike.
    const twins = { nodes: [{ id: "a" }, { id: "b" }], links: [] };
    expect(layoutNetwork(twins)).toEqual(layoutNetwork(twins));
    expect(a.x.every(Number.isFinite) && a.y.every(Number.isFinite)).toBe(true);
    const [a1, a2] = [lcg(1), lcg(1)];
    const seq = Array.from({ length: 5 }, () => a1());
    expect(Array.from({ length: 5 }, () => a2())).toEqual(seq);
    expect(seq.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it("never lets two nodes overlap, and sizes nodes by size", () => {
    const l = layoutNetwork(input);
    const d = (i: number, j: number) => Math.hypot(l.x[i] - l.x[j], l.y[i] - l.y[j]);
    for (let i = 0; i < l.x.length; i++) for (let j = i + 1; j < l.x.length; j++) expect(d(i, j)).toBeGreaterThan(l.r[i] + l.r[j]);
    expect(l.r[1]).toBeGreaterThan(l.r[2]);
  });

  it("fits the settled layout inside the box", () => {
    const p = fitLayout(layoutNetwork(input), 400, 300, 18);
    for (let i = 0; i < p.x.length; i++) {
      expect(p.x[i]).toBeGreaterThan(18);
      expect(p.x[i]).toBeLessThan(382);
      expect(p.y[i]).toBeGreaterThan(18);
      expect(p.y[i]).toBeLessThan(282);
    }
  });
});

describe("sankey drawn", () => {
  it("names every node and link, labels the nodes, and flips to a table of links", async () => {
    const user = userEvent.setup();
    const { container } = render(<UiFlow props={ci} />);
    expect(screen.getByRole("region", { name: "Sankey, 6 nodes, 7 links" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Passed, 213 jobs, end, good" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Lint → Failed, 8 jobs" })).toBeInTheDocument();
    expect([...container.querySelectorAll("[data-part=label]")]).toHaveLength(6);
    expect(container.querySelector('[data-link="lint>fail"]')).toHaveAttribute("stroke", "var(--destructive)");
    expect(screen.getByRole("list", { name: "Legend" })).toHaveTextContent("To or from a problem node");
    await user.click(screen.getByRole("button", { name: "table" }));
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(8);
    expect(rows[4]).toHaveTextContent("LintFailed8 jobs");
  });

  it("moves focus node to node with arrows, along a node's links with Enter, and back with Escape", async () => {
    const user = userEvent.setup();
    render(<UiFlow props={ci} />);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toHaveAttribute("data-node", "push");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Push240 jobs");
    await user.keyboard("{ArrowRight}");
    expect(["lint", "test"]).toContain(document.activeElement!.getAttribute("data-node"));
    const node = document.activeElement!.getAttribute("data-node");
    await user.keyboard("{Enter}");
    expect(document.activeElement!.getAttribute("data-link")).toMatch(new RegExp(`(^${node}>|>${node}$)`));
    expect(screen.getByRole("tooltip")).toHaveTextContent("→");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement!.getAttribute("data-link")).toMatch(new RegExp(`(^${node}>|>${node}$)`));
    await user.keyboard("{Escape}");
    expect(document.activeElement).toHaveAttribute("data-node", node);
  });

  it("shows a cycle as an error the agent can read", () => {
    render(<UiFlow props={{ ...ci, links: [...ci.links, { source: "pass", target: "push", value: 1 }] }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The links form a cycle (push → lint → pass → push)");
  });
});

describe("network drawn", () => {
  it("colours groups from the categorical slots with a legend, and lists each node's neighbours", async () => {
    const user = userEvent.setup();
    const { container } = render(<UiFlow props={services} />);
    const fill = (id: string) => container.querySelector(`[data-node="${id}"] [data-mark=node]`)!.getAttribute("fill");
    expect([fill("web"), fill("api"), fill("auth"), fill("db")]).toEqual(["var(--chart-1)", "var(--chart-2)", "var(--chart-2)", "var(--chart-3)"]);
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["edge", "core", "data"]);
    expect([...container.querySelectorAll("[data-part=label]")].map((t) => t.textContent).sort()).toEqual(["api", "auth", "postgres", "web"]);
    expect(screen.getByRole("img", { name: "api, 3 links, size 5, group core, to web, auth, postgres" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "table" }));
    const api = within(screen.getByRole("table")).getByText("api").closest("tr")!;
    expect(api).toHaveTextContent("apicore3web (900), auth (700), postgres (1,500)");
  });

  it("is one tab stop, with arrows between nodes and Enter along their links", async () => {
    const user = userEvent.setup();
    render(<UiFlow props={services} />);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toHaveAttribute("data-node", "web");
    expect(document.querySelectorAll("[data-node][tabindex='0']")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(document.activeElement).toHaveAttribute("data-link", "web>api");
    await user.keyboard("{Escape}");
    expect(document.activeElement).toHaveAttribute("data-node", "web");
    await user.keyboard("{End}");
    expect(document.activeElement).toHaveAttribute("data-node", "db");
  });
});
