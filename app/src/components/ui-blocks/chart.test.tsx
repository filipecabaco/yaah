// The chart primitive drawn for real: the dataviz mark specs it applies whatever the agent
// sends, reference lines, orientation, direct labels, and the dumbbell.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import UiChart from "@/components/ui-blocks/chart";
import { readLabels, readOrientation, readSort, sortRows, normalise, type Kind } from "@/components/ui-blocks/chart-model";

const weeks = [
  { week: "W1", api: 120, web: 80, jobs: 30 },
  { week: "W2", api: 140, web: 95, jobs: 42 },
  { week: "W3", api: 133, web: 110, jobs: 38 },
];
const three = [
  { key: "api", label: "API" },
  { key: "web", label: "Web" },
  { key: "jobs", label: "Jobs" },
];
/** The research doc's dumbbell example: margin in points, poll against result. */
const polls = [
  { state: "PA", poll: -0.5, result: 1.7 },
  { state: "WI", poll: 0.1, result: 0.9 },
  { state: "MI", poll: -0.8, result: 1.4 },
  { state: "AZ", poll: 1.2, result: 5.5 },
];
const pollSeries = [
  { key: "poll", label: "Poll average" },
  { key: "result", label: "Result" },
];

// happy-dom has no layout: give Recharts' ResponsiveContainer a size to draw into.
beforeAll(() => {
  // The container is 640×240; the legend is a 20px row under the plot.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const [width, height] = this.classList.contains("recharts-responsive-container") ? [640, 240] : [640, 20];
    return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) };
  });
});
afterAll(() => vi.restoreAllMocks());

/** Render a Recharts chart and wait for it: Recharts draws its marks after its own layout pass. */
async function draw(ui: ReactElement) {
  const view = render(ui);
  await waitFor(() => expect(view.container.querySelector(".recharts-surface clipPath rect:not([height='0'])")).not.toBeNull());
  await act(() => new Promise((r) => setTimeout(r, 20)));
  return view;
}

const svgOf = (c: HTMLElement) => c.querySelector("svg.recharts-surface") as SVGSVGElement;

describe("mark specs", () => {
  it("draws a solid hairline grid, never dashed", async () => {
    const { container } = await draw(<UiChart kind="bar" data={weeks} x="week" series={three} />);
    const lines = container.querySelectorAll(".recharts-cartesian-grid line");
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.getAttribute("stroke-dasharray")).toBeNull();
      expect(l).toHaveAttribute("stroke", "var(--border)");
      expect(l).toHaveAttribute("stroke-width", "1");
    }
  });

  it("caps bars at 24px, with a 2px surface gap between stacked segments", async () => {
    const wide = Array.from({ length: 2 }, (_, i) => ({ week: `W${i}`, api: 10 + i, web: 5 }));
    const { container } = await draw(<UiChart kind="bar" data={wide} x="week" series={three.slice(0, 2)} stacked />);
    const bars = [...container.querySelectorAll(".recharts-bar-rectangle path")];
    expect(bars.length).toBe(4);
    for (const b of bars) {
      // Vertical bars: the path's width is in its `width` attribute.
      expect(Number(b.getAttribute("width"))).toBeLessThanOrEqual(24);
      expect(b).toHaveAttribute("stroke", "var(--chart-surface)");
      expect(b).toHaveAttribute("stroke-width", "2");
    }
  });

  it("washes areas at 10% and never smooths a stack (a spline can misstate the total)", async () => {
    const { container } = await draw(<UiChart kind="area" data={weeks} x="week" series={three} stacked />);
    const fills = [...container.querySelectorAll(".recharts-area-area")];
    expect(fills.length).toBe(3);
    for (const f of fills) expect(f).toHaveAttribute("fill-opacity", "0.1");
    // A linear path is only straight segments: M…L…L, no cubic C commands.
    for (const p of container.querySelectorAll(".recharts-area-curve")) expect(p.getAttribute("d")).not.toMatch(/C/);
  });

  it("draws several lines straight, and a single unstacked one may curve", async () => {
    const { container: many } = await draw(<UiChart kind="line" data={weeks} x="week" series={three} />);
    for (const p of many.querySelectorAll(".recharts-line-curve")) expect(p.getAttribute("d")).not.toMatch(/C/);
    const { container: one } = await draw(<UiChart kind="line" data={weeks} x="week" series={["api"]} />);
    expect(one.querySelector(".recharts-line-curve")?.getAttribute("d")).toMatch(/C/);
  });

  it("gives dots 8px of colour inside a 2px surface ring", async () => {
    const { container } = await draw(<UiChart kind="line" data={weeks} x="week" series={three} />);
    const dots = [...container.querySelectorAll(".recharts-line-dots circle")];
    expect(dots.length).toBe(9);
    for (const d of dots) {
      expect(d).toHaveAttribute("r", "5");
      expect(d).toHaveAttribute("stroke-width", "2");
      expect(d).toHaveAttribute("stroke", "var(--chart-surface)");
    }
  });
});

describe("refs", () => {
  it("draws a solid reference line with its label in a text token, on every kind", async () => {
    for (const kind of ["bar", "line", "area"] as const) {
      const { container, unmount } = await draw(
        <UiChart kind={kind} data={weeks} x="week" series={three} refs={[{ axis: "y", value: 100, label: "Target" }]} />,
      );
      const ref = container.querySelector(".recharts-reference-line");
      expect(ref, kind).not.toBeNull();
      const line = ref!.querySelector("line")!;
      expect(line.getAttribute("stroke-dasharray")).toBeNull();
      expect(line).toHaveAttribute("stroke", "var(--muted-foreground)");
      // Recharts draws the label in a layer of its own, above the marks.
      const label = within(container).getByText("Target");
      expect(label.closest("text")).toHaveAttribute("fill", "var(--muted-foreground)");
      unmount();
    }
  });

  it("drops a ref that isn't one", async () => {
    const { container } = await draw(
      <UiChart
        kind="line"
        data={weeks}
        x="week"
        series={three}
        refs={[{ axis: "z", value: 1 }, { axis: "y" }, "nope", { axis: "x", value: "W2" }]}
      />,
    );
    expect(container.querySelectorAll(".recharts-reference-line")).toHaveLength(1);
  });
});

describe("orientation", () => {
  it("lays long-named bars on their side by itself, and follows an explicit choice", async () => {
    const long = [
      { team: "Platform engineering", n: 4 },
      { team: "Developer experience", n: 7 },
    ];
    const auto = await draw(<UiChart kind="bar" data={long} x="team" series={["n"]} />);
    expect(auto.container.querySelector("[data-orientation]")).toHaveAttribute("data-orientation", "horizontal");
    auto.unmount();
    const forced = await draw(<UiChart kind="bar" data={long} x="team" series={["n"]} orientation="vertical" />);
    expect(forced.container.querySelector("[data-orientation]")).toHaveAttribute("data-orientation", "vertical");
    forced.unmount();
    const side = await draw(<UiChart kind="bar" data={weeks} x="week" series={three} orientation="horizontal" />);
    expect(side.container.querySelector("[data-orientation]")).toHaveAttribute("data-orientation", "horizontal");
    // On its side the category axis is the y axis.
    expect(side.container.querySelector(".recharts-yAxis-tick-labels")?.textContent).toContain("W1");
  });

  it("reads defaults per kind", () => {
    const rows = normalise(weeks, three, "week").data;
    const cases: [Kind, unknown, string][] = [
      ["line", "horizontal", "vertical"],
      ["area", undefined, "vertical"],
      ["dumbbell", undefined, "horizontal"],
      ["dumbbell", "vertical", "vertical"],
      ["bar", undefined, "vertical"],
    ];
    for (const [kind, raw, want] of cases) expect(readOrientation(raw, kind, rows), `${kind} ${String(raw)}`).toBe(want);
  });
});

describe("labels", () => {
  it("labels the end of each series by default on lines and areas, in a text token", async () => {
    const { container } = await draw(<UiChart kind="area" data={weeks} x="week" series={three} stacked />);
    const ends = [...container.querySelectorAll('[data-part="end-label"]')];
    expect(ends.map((e) => e.textContent)).toEqual(["API 133", "Web 110", "Jobs 38"]);
    for (const e of ends) expect(e).toHaveAttribute("fill", "var(--foreground)");
  });

  it("draws no labels with `none`, and one per point with `all`", async () => {
    const none = await draw(<UiChart kind="line" data={weeks} x="week" series={three} labels="none" />);
    expect(none.container.querySelectorAll('[data-part="end-label"], [data-part="value-label"]')).toHaveLength(0);
    none.unmount();
    const all = await draw(<UiChart kind="line" data={weeks} x="week" series={["api"]} labels="all" />);
    expect([...all.container.querySelectorAll('[data-part="value-label"]')].map((e) => e.textContent)).toEqual(["120", "140", "133"]);
  });

  it("drops end labels that would collide rather than nudge them off their lines", async () => {
    const close = [
      { t: "a", p: 10, q: 10.1 },
      { t: "b", p: 11, q: 11.05 },
    ];
    const { container } = await draw(<UiChart kind="line" data={close} x="t" series={["p", "q"]} />);
    expect(container.querySelectorAll('[data-part="end-label"]')).toHaveLength(0);
  });

  it("keeps bars bare by default and puts the value at the tip when asked", async () => {
    expect(readLabels(undefined, "bar")).toBe("none");
    expect(readLabels(undefined, "dumbbell")).toBe("ends");
    const { container } = await draw(<UiChart kind="bar" data={weeks} x="week" series={["api"]} labels="ends" />);
    expect([...container.querySelectorAll('[data-part="value-label"]')].map((e) => e.textContent)).toEqual(["120", "140", "133"]);
  });
});

describe("dumbbell", () => {
  const dumbbell = (extra: Record<string, unknown> = {}) =>
    render(
      <UiChart kind="dumbbell" data={polls} x="state" series={pollSeries} refs={[{ axis: "y", value: 0, label: "Tie" }]} unit=" pts" {...extra} />,
    );

  it("draws one row per category: two ringed dots, a connector, and the gap at the row end", () => {
    const { container } = dumbbell();
    const rows = screen.getAllByRole("listitem").filter((r) => r.hasAttribute("data-row"));
    expect(rows.map((r) => r.getAttribute("data-row"))).toEqual(["PA", "WI", "MI", "AZ"]);
    for (const r of rows) {
      expect(r.querySelectorAll('[data-mark="dot"]')).toHaveLength(2);
      for (const d of r.querySelectorAll('[data-mark="dot"]')) expect(d).toHaveAttribute("r", "4");
      expect(r.querySelector('[data-part="connector"]')).toHaveAttribute("stroke", "var(--muted-foreground)");
      // The hit target is the row's band, not the dot.
      expect(Number(r.querySelector('[data-part="hit"]')!.getAttribute("height"))).toBeGreaterThanOrEqual(24);
    }
    const gaps = [...container.querySelectorAll('[data-part="gap"]')];
    expect(gaps.map((g) => g.textContent)).toEqual(["+2.2 pts", "+0.8 pts", "+2.2 pts", "+4.3 pts"]);
    for (const g of gaps) expect(g).toHaveClass("fill-foreground");
    // The legend names both series.
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(within(legend).getByText("Poll average")).toBeInTheDocument();
    expect(within(legend).getByText("Result")).toBeInTheDocument();
  });

  it("draws the Tie ref at zero, between negative and positive values", () => {
    const { container } = dumbbell();
    const tie = container.querySelector(".ui-ref")!;
    expect(within(tie as unknown as HTMLElement).getByText("Tie")).toBeInTheDocument();
    const x0 = Number(tie.querySelector("line")!.getAttribute("x1"));
    const dotsOf = (state: string) =>
      [...container.querySelectorAll(`[data-row="${state}"] [data-mark="dot"]`)].map((d) => Number(d.getAttribute("cx")));
    const [poll, result] = dotsOf("MI");
    // MI polled -0.8 and came in at +1.4: the dots sit on either side of the tie.
    expect(poll).toBeLessThan(x0);
    expect(result).toBeGreaterThan(x0);
  });

  it("sorts by the widest gap", () => {
    dumbbell({ sort: "gap" });
    const rows = screen.getAllByRole("listitem").filter((r) => r.hasAttribute("data-row"));
    expect(rows.map((r) => r.getAttribute("data-row"))).toEqual(["AZ", "PA", "MI", "WI"]);
  });

  it("refuses anything but two series, saying why", () => {
    render(<UiChart kind="dumbbell" data={polls} x="state" series={[{ key: "poll" }]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("A dumbbell needs exactly 2 series");
  });

  it("flips to a table with the gap", async () => {
    const user = userEvent.setup();
    dumbbell();
    await user.click(screen.getByRole("button", { name: "table" }));
    const table = screen.getByRole("table");
    expect(within(table).getByText("Gap")).toBeInTheDocument();
    expect(within(table).getByText("+4.3 pts")).toBeInTheDocument();
    expect(within(table).getByText("-0.8 pts")).toBeInTheDocument();
  });

  it("shows the tooltip on keyboard focus, as on hover, and arrows move between rows", async () => {
    const user = userEvent.setup();
    dumbbell();
    await user.tab();
    await user.tab();
    await user.tab();
    const pa = document.querySelector('[data-row="PA"]')!;
    expect(pa).toHaveFocus();
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("PA");
    expect(tip).toHaveTextContent("-0.5 pts");
    expect(tip).toHaveTextContent("+2.2 pts");
    expect(pa).toHaveAttribute("aria-describedby", tip.id);
    // The row's name carries the same, so the tooltip never gates it.
    expect(pa.getAttribute("aria-label")).toBe("PA: Poll average -0.5 pts, Result 1.7 pts, gap +2.2 pts");
    await user.keyboard("{ArrowDown}");
    expect(document.querySelector('[data-row="WI"]')).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("WI");
  });

  it("colours dots by side on a diverging scale, the first series hollow, with a scale legend", () => {
    const { container } = dumbbell({ scale: { type: "diverging", domain: [-6, 6], midpoint: 0, bins: 7 } });
    const dots = (state: string) => [...container.querySelectorAll(`[data-row="${state}"] [data-mark="dot"]`)];
    // Dots are small marks: 7 bins become 5 and the pale steps are skipped, so every dot holds up on the surface.
    // Over -6…6, WI's poll (+0.1) is in the middle (the muted text gray), hollow; AZ's result (+5.5) in the strongest warm bin.
    expect(dots("WI")[0]).toHaveAttribute("stroke", "var(--muted-foreground)");
    expect(dots("WI")[0]).toHaveAttribute("fill", "var(--chart-surface)");
    expect(dots("AZ")[1]).toHaveAttribute("fill", "var(--scale-div-pos-3)");
    expect(dots("AZ")[0]).toHaveAttribute("stroke", "var(--scale-div-pos-2)");
    const legend = screen.getByLabelText("Colour scale");
    expect(legend).toHaveTextContent("-6 pts to 6 pts");
    expect(legend.querySelectorAll("[title]")).toHaveLength(5);
    expect(container.innerHTML).not.toMatch(/scale-div-(neg|pos)-1|scale-div-mid/);
  });

  it("defaults to two shades of one hue (before → after)", () => {
    const { container } = dumbbell();
    const [poll, result] = [...container.querySelectorAll('[data-row="PA"] [data-mark="dot"]')];
    expect(poll).toHaveAttribute("fill", "var(--scale-seq-400)");
    expect(result).toHaveAttribute("fill", "var(--scale-seq-700)");
  });
});

describe("sorting", () => {
  it("sorts bars by total and keeps line order", () => {
    const { data, series } = normalise(weeks, three, "week");
    expect(sortRows(data, series, readSort("value", "bar"), "bar").map((r) => r.x)).toEqual(["W3", "W2", "W1"]);
    expect(readSort("value", "line")).toBe("none");
    expect(readSort("gap", "bar")).toBe("none");
  });
});

it("never draws text in a series colour", async () => {
  const { container } = await draw(<UiChart kind="line" data={weeks} x="week" series={three} refs={[{ axis: "y", value: 100, label: "Target" }]} />);
  for (const t of svgOf(container).querySelectorAll("text")) expect(t.getAttribute("fill") ?? "").not.toMatch(/--color-|--chart-/);
});
