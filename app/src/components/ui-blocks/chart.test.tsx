// The chart primitive drawn for real: the dataviz mark specs it applies whatever the agent
// sends, reference lines, orientation, direct labels, and the dumbbell.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import UiChart, { BAND_OPACITY, WASH_OPACITY } from "@/components/ui-blocks/chart";
import { readLabels, readOrientation, readSort, sortRows, normalise, type Kind } from "@/components/ui-blocks/chart-model";
import { readIndexCss } from "@/test/css-tokens";

const css = await readIndexCss();

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

  it("washes a single area at 10% under its line", async () => {
    const { container } = await draw(<UiChart kind="area" data={weeks} x="week" series={["api"]} />);
    const fill = container.querySelector(".recharts-area-area")!;
    expect(fill).toHaveAttribute("fill-opacity", String(WASH_OPACITY));
    expect(fill.closest(".ui-band")).toBeNull();
    expect(container.querySelector(".recharts-area-curve")).toHaveAttribute("stroke", "var(--color-series-0)");
  });

  it("fills stacked bands strongly enough to tell apart, with a 2px surface seam, and never smooths a stack", async () => {
    const { container } = await draw(<UiChart kind="area" data={weeks} x="week" series={three} stacked />);
    const fills = [...container.querySelectorAll(".recharts-area-area")];
    expect(fills.length).toBe(3);
    expect(BAND_OPACITY).toBeGreaterThanOrEqual(0.35);
    expect(BAND_OPACITY).toBeLessThanOrEqual(0.55);
    for (const f of fills) {
      expect(f).toHaveAttribute("fill-opacity", String(BAND_OPACITY));
      // index.css tunes the opacity per mode through this class.
      expect(f.closest(".ui-band")).not.toBeNull();
    }
    for (const p of container.querySelectorAll(".recharts-area-curve")) {
      expect(p).toHaveAttribute("stroke", "var(--chart-surface)");
      expect(p).toHaveAttribute("stroke-width", "2");
      // A linear path is only straight segments: M…L…L, no cubic C commands.
      expect(p.getAttribute("d")).not.toMatch(/C/);
    }
    // The legend keeps the series colours (a band's stroke is the surface seam, not its colour).
    const swatches = [...container.querySelectorAll<HTMLElement>(".recharts-legend-wrapper .rounded-\\[2px\\]")];
    expect(swatches.map((sw) => sw.style.backgroundColor)).toEqual(["var(--chart-1)", "var(--chart-2)", "var(--chart-3)"]);
    // Each mode has its own band opacity, both inside the 0.35–0.55 band.
    const light = Number(/\.ui-chart \{[^}]*--chart-band-opacity: ([\d.]+)/.exec(css)?.[1]);
    const dark = Number(/\.dark \.ui-chart \{[^}]*--chart-band-opacity: ([\d.]+)/.exec(css)?.[1]);
    for (const o of [light, dark]) expect(o >= 0.35 && o <= 0.55, String(o)).toBe(true);
    expect(css).toMatch(/\.ui-band \.recharts-area-area \{\s*fill-opacity: var\(--chart-band-opacity\)/);
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
      expect(line).toHaveAttribute("stroke-width", "1");
      // The label is drawn by the chart, in a text token, with a halo in the surface colour.
      const label = within(container).getByText("Target").closest("text")!;
      expect(label).toHaveAttribute("fill", "var(--muted-foreground)");
      expect(label).toHaveAttribute("stroke", "var(--chart-surface)");
      expect(label).toHaveAttribute("paint-order", "stroke");
      unmount();
    }
  });

  it("puts a horizontal ref's label outside the plot, right of every mark", async () => {
    const { container } = await draw(
      <UiChart kind="line" data={weeks} x="week" series={three} refs={[{ axis: "y", value: 100, label: "Yearly average" }]} />,
    );
    const label = container.querySelector('[data-part="ref-label"]')!;
    expect(label).toHaveTextContent("Yearly average");
    const right = Math.max(...[...container.querySelectorAll(".recharts-line-dots circle")].map((d) => Number(d.getAttribute("cx"))));
    expect(Number(label.getAttribute("x"))).toBeGreaterThan(right);
    // The line stops at the plot's edge, before the label.
    const line = container.querySelector(".recharts-reference-line line")!;
    expect(Number(line.getAttribute("x2"))).toBeLessThan(Number(label.getAttribute("x")));
  });

  it("puts a vertical ref's label in a gutter above the plot, over no bar", async () => {
    const rates = ["A", "B", "C"].map((c, i) => ({ c: `Country ${c}`, r: [91, 86, 52][i] }));
    const { container } = await draw(
      <UiChart
        kind="bar"
        orientation="horizontal"
        data={rates}
        x="c"
        series={["r"]}
        unit="%"
        refs={[{ axis: "y", value: 80, label: "Target 80%" }]}
      />,
    );
    const label = container.querySelector('[data-part="ref-label"]')!;
    expect(label).toHaveTextContent("Target 80%");
    const top = Math.min(...[...container.querySelectorAll(".recharts-bar-rectangle path")].map((b) => Number(b.getAttribute("y"))));
    expect(Number(label.getAttribute("y"))).toBeLessThan(top);
    // Over bars the target line is drawn on top of them, still a hairline.
    expect(container.querySelector(".recharts-reference-line line")).toHaveAttribute("stroke-width", "1");
  });

  it("dodges a ref label and end labels that share the gutter", async () => {
    const { container } = await draw(
      <UiChart kind="line" data={weeks} x="week" series={["api"]} refs={[{ axis: "y", value: 133, label: "Peak" }]} />,
    );
    const ys = [...container.querySelectorAll('[data-part="end-label"], [data-part="ref-label"]')].map((e) => Number(e.getAttribute("y")));
    expect(ys).toHaveLength(2);
    expect(Math.abs(ys[0] - ys[1])).toBeGreaterThanOrEqual(15);
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

  it("nudges end labels that would collide apart, with a leader line to their marks, instead of dropping them", async () => {
    const close = [
      { t: "a", p: 10, q: 10.1 },
      { t: "b", p: 11, q: 11.05 },
    ];
    const { container } = await draw(<UiChart kind="line" data={close} x="t" series={["p", "q"]} />);
    const ends = [...container.querySelectorAll('[data-part="end-label"]')];
    expect(ends.map((e) => e.textContent)).toEqual(["p 11", "q 11.05"]);
    const [a, b] = ends.map((e) => Number(e.getAttribute("y")));
    // At least a line of text apart (12px text + 3px).
    expect(Math.abs(a - b)).toBeGreaterThanOrEqual(15);
    expect(container.querySelectorAll('[data-part="leader"]').length).toBeGreaterThan(0);
    // The legend is there too: identity never rests on the labels alone.
    expect(container.querySelector(".recharts-legend-wrapper")?.textContent).toContain("q");
  });

  it("puts stacked end labels in the middle of their band at the last point", async () => {
    const rows = [
      { t: "a", p: 5, q: 5 },
      { t: "b", p: 10, q: 10 },
    ];
    const { container } = await draw(<UiChart kind="area" data={rows} x="t" series={["p", "q"]} stacked />);
    // The axis runs 0–20 (zero-based, a stack); p's band is 0–10 at the end, so its label sits at 5, q's at 15.
    const tickY = (v: string) =>
      Number([...container.querySelectorAll('.recharts-yAxis-tick-labels [data-part="tick"]')].find((t) => t.textContent === v)!.getAttribute("y"));
    const y = (v: number) => tickY("0") + ((tickY("20") - tickY("0")) * v) / 20;
    const [p, q] = [...container.querySelectorAll('[data-part="end-label"]')].map((e) => Number(e.getAttribute("y")));
    expect(Math.abs(p - y(5))).toBeLessThan(1);
    expect(Math.abs(q - y(15))).toBeLessThan(1);
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

  it("keeps the tooltip inside the plot, above the axis, on the last row too", async () => {
    const user = userEvent.setup();
    const { container } = dumbbell();
    await user.tab();
    await user.tab();
    await user.tab();
    await user.keyboard("{End}");
    expect(document.querySelector('[data-row="AZ"]')).toHaveFocus();
    const tip = screen.getByRole("tooltip");
    // 4 rows of 28px under a 22px top: the plot ends at 134px, where the axis labels start.
    const axisTop = Math.min(...[...container.querySelectorAll('[data-part="axis"] text')].map((t) => Number(t.getAttribute("y")))) - 12;
    expect(parseFloat(tip.style.top) + 84).toBeLessThanOrEqual(axisTop + 1);
    expect(parseFloat(tip.style.top)).toBeGreaterThanOrEqual(0);
    expect(tip.dataset.place).toMatch(/^(right|left) beside$/);
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

describe("value axis", () => {
  const ticks = (c: HTMLElement, axis: "x" | "y" = "y") =>
    [...c.querySelectorAll(`.recharts-${axis}Axis-tick-labels [data-part="tick"]`)].map((t) => t.textContent);

  it("starts bars at zero and fits a line to its data", async () => {
    const index = [100, 104.8, 112.3, 118.1].map((close, i) => ({ m: `M${i}`, close }));
    const bar = await draw(<UiChart kind="bar" data={index} x="m" series={["close"]} />);
    expect(ticks(bar.container)[0]).toBe("0");
    bar.unmount();
    const line = await draw(<UiChart kind="line" data={index} x="m" series={["close"]} refs={[{ axis: "y", value: 100, label: "Start" }]} />);
    const ys = ticks(line.container).map(Number);
    expect(ys[0]).toBeGreaterThan(80);
    expect(ys[0]).toBeLessThanOrEqual(100);
    expect(ys[ys.length - 1]).toBeGreaterThanOrEqual(118.1);
    line.unmount();
    const zero = await draw(<UiChart kind="line" data={index} x="m" series={["close"]} zero />);
    expect(ticks(zero.container)[0]).toBe("0");
  });

  it("never wraps a tick label, and makes the axis wide enough for it", async () => {
    const temps = [-8, 0, 18, 30].map((t, i) => ({ m: `M${i}`, t }));
    const { container } = await draw(<UiChart kind="line" data={temps} x="m" series={["t"]} unit=" °C" />);
    const labels = [...container.querySelectorAll('.recharts-yAxis-tick-labels [data-part="tick"]')];
    expect(labels.map((t) => t.textContent)).toContain("-10 °C");
    for (const t of labels) expect(t.querySelectorAll("tspan")).toHaveLength(0);
    // "100%" isn't clipped either: the axis is as wide as its widest tick.
    const share = [{ m: "a", s: 60, o: 40 }];
    const stacked = await draw(<UiChart kind="area" stacked data={share} x="m" series={["s", "o"]} unit="%" />);
    const top = [...stacked.container.querySelectorAll('.recharts-yAxis-tick-labels [data-part="tick"]')].find((t) => t.textContent === "100%")!;
    expect(top).toBeDefined();
    // Right-aligned at x: the text (4 characters at 12px) has room to its left.
    expect(Number(top.getAttribute("x"))).toBeGreaterThanOrEqual(4 * 12 * 0.6);
  });

  it("sizes chart text from the interface font size, never under 11px", async () => {
    const root = document.documentElement;
    const tickSize = async () => {
      const v = await draw(<UiChart kind="line" data={weeks} x="week" series={three} />);
      const size = v.container.querySelector('[data-part="tick"]')!.getAttribute("font-size");
      v.unmount();
      return Number(size);
    };
    expect(await tickSize()).toBe(12);
    root.style.fontSize = "20px";
    try {
      expect(await tickSize()).toBe(15);
      root.style.fontSize = "12px";
      expect(await tickSize()).toBe(11);
    } finally {
      root.style.fontSize = "";
    }
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
