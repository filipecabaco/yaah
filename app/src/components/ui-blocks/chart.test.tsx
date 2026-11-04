// The chart primitive drawn for real: the dataviz mark specs it applies whatever the agent
// sends, reference lines, orientation, direct labels, keyboard and hover, the table and Expand,
// and the dumbbell. React draws the SVG at a known size in happy-dom (useSize's fallback, 640px
// wide), so nothing is mocked and nothing waits for a layout pass.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import UiChart, { BAND_OPACITY, BAR_MAX, GAP, WASH_OPACITY } from "@/components/ui-blocks/chart";
import { pathBox } from "@/components/ui-blocks/chart-geometry";
import { readLabels, readOrientation, readSort, sortRows, normalise, type Kind } from "@/components/ui-blocks/chart-model";
import { UiTree } from "@/components/ui-render";
import { UiViewContext } from "@/components/ui-view";
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

const svgOf = (c: HTMLElement) => c.querySelector(".ui-chart svg[role='list']") as SVGSVGElement;
const bars = (c: HTMLElement) => [...c.querySelectorAll('[data-part="bar"]')];
const boxOf = (el: Element) => pathBox(el.getAttribute("d")!);
const ticks = (c: HTMLElement, axis: "value" | "category" = "value") =>
  [...c.querySelectorAll(`[data-axis="${axis}"] [data-part="tick"]`)].map((t) => t.textContent);
const tickY = (c: HTMLElement, text: string) =>
  Number([...c.querySelectorAll('[data-axis="value"] [data-part="tick"]')].find((t) => t.textContent === text)!.getAttribute("y"));

describe("mark specs", () => {
  it("draws a solid hairline grid, never dashed", () => {
    const { container } = render(<UiChart kind="bar" data={weeks} x="week" series={three} />);
    const lines = container.querySelectorAll('[data-part="grid"] line');
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.getAttribute("stroke-dasharray")).toBeNull();
      expect(l).toHaveAttribute("stroke", "var(--border)");
      expect(l).toHaveAttribute("stroke-width", "1");
    }
  });

  it("caps bars at 24px, with a 2px surface gap between stacked segments and a rounded end only on top", () => {
    const wide = Array.from({ length: 2 }, (_, i) => ({ week: `W${i}`, api: 10 + i, web: 5 }));
    const { container } = render(<UiChart kind="bar" data={wide} x="week" series={three.slice(0, 2)} stacked />);
    const all = bars(container);
    expect(all.length).toBe(4);
    expect(BAR_MAX).toBe(24);
    for (const b of all) expect(boxOf(b).w).toBeLessThanOrEqual(24);
    const zero = tickY(container, "0");
    for (const row of ["0", "1"]) {
      const [base, top] = all.filter((b) => b.getAttribute("data-index") === row);
      const [lo, hi] = [boxOf(base), boxOf(top)];
      // The stack sits on the baseline; the seam between its segments is exactly the surface gap.
      expect(lo.y + lo.h).toBeCloseTo(zero, 1);
      expect(lo.y - (hi.y + hi.h)).toBeCloseTo(GAP, 1);
      // 4px rounded data-end on the stack's top, square at the baseline and at the seam.
      expect(top.getAttribute("d")).toMatch(/Q/);
      expect(base.getAttribute("d")).not.toMatch(/Q/);
    }
  });

  it("puts a group's bars side by side, a 2px gap apart, each rounded at its end", () => {
    const { container } = render(<UiChart kind="bar" data={weeks} x="week" series={three} />);
    const row = bars(container)
      .filter((b) => b.getAttribute("data-index") === "0")
      .map(boxOf);
    expect(row).toHaveLength(3);
    expect(row[1].x - (row[0].x + row[0].w)).toBeCloseTo(GAP, 1);
    expect(row[2].x - (row[1].x + row[1].w)).toBeCloseTo(GAP, 1);
    for (const b of bars(container)) expect(b.getAttribute("d")).toMatch(/Q/);
  });

  it("stacks negative values below zero, rounded at their own end", () => {
    const churn = [{ m: "Jan", added: 12, lost: -5 }];
    const { container } = render(<UiChart kind="bar" data={churn} x="m" series={["added", "lost"]} stacked />);
    const zero = tickY(container, "0");
    const [up, down] = bars(container).map(boxOf);
    expect(up.y + up.h).toBeCloseTo(zero, 1);
    expect(down.y).toBeCloseTo(zero, 1);
    expect(bars(container)[1].getAttribute("d")).toMatch(/Q/);
  });

  it("washes a single area at 10% under its line", () => {
    const { container } = render(<UiChart kind="area" data={weeks} x="week" series={["api"]} />);
    const fill = container.querySelector('[data-part="area"]')!;
    expect(fill).toHaveAttribute("fill-opacity", String(WASH_OPACITY));
    expect(fill.closest(".ui-band")).toBeNull();
    const line = container.querySelector('[data-part="line"]')!;
    expect(line).toHaveAttribute("stroke", "var(--chart-1)");
    expect(line).toHaveAttribute("stroke-width", "2");
  });

  it("fills stacked bands strongly enough to tell apart, with a 2px surface seam, and never smooths a stack", () => {
    const { container } = render(<UiChart kind="area" data={weeks} x="week" series={three} stacked />);
    const fills = [...container.querySelectorAll('[data-part="area"]')];
    expect(fills.length).toBe(3);
    expect(BAND_OPACITY).toBeGreaterThanOrEqual(0.35);
    expect(BAND_OPACITY).toBeLessThanOrEqual(0.55);
    for (const f of fills) {
      expect(f).toHaveAttribute("fill-opacity", String(BAND_OPACITY));
      // index.css tunes the opacity per mode through this class.
      expect(f.closest(".ui-band")).not.toBeNull();
    }
    for (const p of container.querySelectorAll('[data-part="line"]')) {
      expect(p).toHaveAttribute("stroke", "var(--chart-surface)");
      expect(p).toHaveAttribute("stroke-width", "2");
      // A linear path is only straight segments: M…L…L, no cubic C commands.
      expect(p.getAttribute("d")).not.toMatch(/C/);
    }
    for (const f of fills) expect(f.getAttribute("d")).not.toMatch(/C/);
    // The legend keeps the series colours (a band's stroke is the surface seam, not its colour).
    const legend = screen.getByRole("list", { name: "Legend" });
    const swatches = [...legend.querySelectorAll<HTMLElement>(".rounded-\\[2px\\]")];
    expect(swatches.map((sw) => sw.style.background)).toEqual(["var(--chart-1)", "var(--chart-2)", "var(--chart-3)"]);
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["API", "Web", "Jobs"]);
    // Each mode has its own band opacity, both inside the 0.35–0.55 band.
    const light = Number(/\.ui-chart \{[^}]*--chart-band-opacity: ([\d.]+)/.exec(css)?.[1]);
    const dark = Number(/\.dark \.ui-chart \{[^}]*--chart-band-opacity: ([\d.]+)/.exec(css)?.[1]);
    for (const o of [light, dark]) expect(o >= 0.35 && o <= 0.55, String(o)).toBe(true);
    expect(css).toMatch(/\.ui-band \[data-part="area"\] \{\s*fill-opacity: var\(--chart-band-opacity\)/);
  });

  it("draws several lines straight, and a single unstacked one may curve", () => {
    const { container: many, unmount } = render(<UiChart kind="line" data={weeks} x="week" series={three} />);
    const lines = many.querySelectorAll('[data-part="line"]');
    expect(lines).toHaveLength(3);
    for (const p of lines) expect(p.getAttribute("d")).not.toMatch(/C/);
    unmount();
    const { container: one } = render(<UiChart kind="line" data={weeks} x="week" series={["api"]} />);
    expect(one.querySelector('[data-part="line"]')?.getAttribute("d")).toMatch(/C/);
  });

  it("leaves a gap in a line where a value is missing", () => {
    const holes = [
      { t: "a", v: 1 },
      { t: "b", v: null },
      { t: "c", v: 3 },
      { t: "d", v: 4 },
    ];
    const { container } = render(<UiChart kind="line" data={holes} x="t" series={["v"]} />);
    // Two runs: a lone point, then c → d.
    expect(container.querySelector('[data-part="line"]')!.getAttribute("d")!.match(/M/g)).toHaveLength(2);
    expect(container.querySelectorAll('[data-mark="dot"]')).toHaveLength(3);
  });

  it("gives dots 8px of colour inside a 2px surface ring", () => {
    const { container } = render(<UiChart kind="line" data={weeks} x="week" series={three} />);
    const dots = [...container.querySelectorAll('[data-mark="dot"]')];
    expect(dots.length).toBe(9);
    for (const d of dots) {
      expect(d).toHaveAttribute("r", "5");
      expect(d).toHaveAttribute("stroke-width", "2");
      expect(d).toHaveAttribute("stroke", "var(--chart-surface)");
    }
  });
});

describe("refs", () => {
  it("draws a solid reference line with its label in a text token, on every kind", () => {
    for (const kind of ["bar", "line", "area"] as const) {
      const { container, unmount } = render(
        <UiChart kind={kind} data={weeks} x="week" series={three} refs={[{ axis: "y", value: 100, label: "Target" }]} />,
      );
      const ref = container.querySelector('[data-part="ref"]');
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

  it("puts a horizontal ref's label outside the plot, right of every mark", () => {
    const { container } = render(
      <UiChart kind="line" data={weeks} x="week" series={three} refs={[{ axis: "y", value: 100, label: "Yearly average" }]} />,
    );
    const label = container.querySelector('[data-part="ref-label"]')!;
    expect(label).toHaveTextContent("Yearly average");
    const right = Math.max(...[...container.querySelectorAll('[data-mark="dot"]')].map((d) => Number(d.getAttribute("cx"))));
    expect(Number(label.getAttribute("x"))).toBeGreaterThan(right);
    // The line stops at the plot's edge, before the label.
    const line = container.querySelector('[data-part="ref"] line')!;
    expect(Number(line.getAttribute("x2"))).toBeLessThan(Number(label.getAttribute("x")));
  });

  it("puts a vertical ref's label in a gutter above the plot, over no bar, and the line over the bars", () => {
    const rates = ["A", "B", "C"].map((c, i) => ({ c: `Country ${c}`, r: [91, 86, 52][i] }));
    const { container } = render(
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
    const top = Math.min(...bars(container).map((b) => boxOf(b).y));
    expect(Number(label.getAttribute("y"))).toBeLessThan(top);
    // Over bars the target line is drawn on top of them (later in the document), still a hairline.
    const line = container.querySelector('[data-part="ref"] line')!;
    expect(line).toHaveAttribute("stroke-width", "1");
    expect(bars(container)[0].compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("draws ref lines under lines and areas", () => {
    const { container } = render(<UiChart kind="line" data={weeks} x="week" series={three} refs={[{ axis: "y", value: 100 }]} />);
    const line = container.querySelector('[data-part="ref"] line')!;
    expect(line.compareDocumentPosition(container.querySelector('[data-part="line"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("dodges a ref label and end labels that share the gutter", () => {
    const { container } = render(<UiChart kind="line" data={weeks} x="week" series={["api"]} refs={[{ axis: "y", value: 133, label: "Peak" }]} />);
    const ys = [...container.querySelectorAll('[data-part="end-label"], [data-part="ref-label"]')].map((e) => Number(e.getAttribute("y")));
    expect(ys).toHaveLength(2);
    expect(Math.abs(ys[0] - ys[1])).toBeGreaterThanOrEqual(15);
  });

  it("drops a ref that isn't one, and draws a category ref at its category", () => {
    const { container } = render(
      <UiChart
        kind="line"
        data={weeks}
        x="week"
        series={three}
        refs={[{ axis: "z", value: 1 }, { axis: "y" }, "nope", { axis: "x", value: "W2" }]}
      />,
    );
    const refs = container.querySelectorAll('[data-part="ref"]');
    expect(refs).toHaveLength(1);
    const x = Number(refs[0].querySelector("line")!.getAttribute("x1"));
    const w2 = container.querySelectorAll('[data-series="series-0"] [data-mark="dot"]')[1];
    expect(x).toBeCloseTo(Number(w2.getAttribute("cx")), 1);
  });
});

describe("orientation", () => {
  it("lays long-named bars on their side by itself, and follows an explicit choice", () => {
    const long = [
      { team: "Platform engineering", n: 4 },
      { team: "Developer experience", n: 7 },
    ];
    const auto = render(<UiChart kind="bar" data={long} x="team" series={["n"]} />);
    expect(auto.container.querySelector("[data-orientation]")).toHaveAttribute("data-orientation", "horizontal");
    auto.unmount();
    const forced = render(<UiChart kind="bar" data={long} x="team" series={["n"]} orientation="vertical" />);
    expect(forced.container.querySelector("[data-orientation]")).toHaveAttribute("data-orientation", "vertical");
    forced.unmount();
    const side = render(<UiChart kind="bar" data={weeks} x="week" series={three} orientation="horizontal" />);
    expect(side.container.querySelector("[data-orientation]")).toHaveAttribute("data-orientation", "horizontal");
    // On its side the category axis is on the left (right-aligned labels) and bars grow rightwards.
    expect(ticks(side.container, "category")).toEqual(["W1", "W2", "W3"]);
    expect(side.container.querySelector('[data-axis="category"] text')).toHaveAttribute("text-anchor", "end");
    const b = boxOf(bars(side.container)[0]);
    expect(b.h).toBeLessThanOrEqual(24);
    expect(bars(side.container)[0].getAttribute("d")).toMatch(/Q/);
  });

  it("cuts a long category name on its side with the full name in a title", () => {
    const long = [{ team: "An extremely long team name that goes on and on and on", n: 4 }];
    const { container } = render(<UiChart kind="bar" data={long} x="team" series={["n"]} />);
    const t = container.querySelector('[data-axis="category"] text')!;
    expect(t.textContent).toMatch(/…$/);
    expect(t.querySelector("title")).toHaveTextContent(long[0].team);
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
  it("labels the end of each series by default on lines and areas, in a text token", () => {
    const { container } = render(<UiChart kind="area" data={weeks} x="week" series={three} stacked />);
    const ends = [...container.querySelectorAll('[data-part="end-label"]')];
    expect(ends.map((e) => e.textContent)).toEqual(["API 133", "Web 110", "Jobs 38"]);
    for (const e of ends) expect(e).toHaveAttribute("fill", "var(--foreground)");
  });

  it("draws no labels with `none`, and one per point with `all`", () => {
    const none = render(<UiChart kind="line" data={weeks} x="week" series={three} labels="none" />);
    expect(none.container.querySelectorAll('[data-part="end-label"], [data-part="value-label"]')).toHaveLength(0);
    none.unmount();
    const all = render(<UiChart kind="line" data={weeks} x="week" series={["api"]} labels="all" />);
    expect([...all.container.querySelectorAll('[data-part="value-label"]')].map((e) => e.textContent)).toEqual(["120", "140", "133"]);
  });

  it("nudges end labels that would collide apart, with a leader line to their marks, instead of dropping them", () => {
    const close = [
      { t: "a", p: 10, q: 10.1 },
      { t: "b", p: 11, q: 11.05 },
    ];
    const { container } = render(<UiChart kind="line" data={close} x="t" series={["p", "q"]} />);
    const ends = [...container.querySelectorAll('[data-part="end-label"]')];
    expect(ends.map((e) => e.textContent)).toEqual(["p 11", "q 11.05"]);
    const [a, b] = ends.map((e) => Number(e.getAttribute("y")));
    // At least a line of text apart (12px text + 3px).
    expect(Math.abs(a - b)).toBeGreaterThanOrEqual(15);
    expect(container.querySelectorAll('[data-part="leader"]').length).toBeGreaterThan(0);
    // The legend is there too: identity never rests on the labels alone.
    expect(screen.getByRole("list", { name: "Legend" })).toHaveTextContent("q");
  });

  it("shows no legend for one series, unless its end label had to go", () => {
    const { unmount } = render(<UiChart kind="line" data={weeks} x="week" series={["api"]} />);
    expect(screen.queryByRole("list", { name: "Legend" })).toBeNull();
    unmount();
    // A gutter full of reference labels (they win): the end label is dropped, and the legend names the series instead.
    const crowd = Array.from({ length: 12 }, (_, i) => ({ axis: "y", value: 128 + i, label: `R${i}` }));
    const { container } = render(<UiChart kind="line" data={weeks} x="week" series={["api"]} height={140} refs={crowd} />);
    expect(container.querySelector('[data-part="end-label"]')).toBeNull();
    expect(screen.getByRole("list", { name: "Legend" })).toHaveTextContent("api");
  });

  it("puts stacked end labels in the middle of their band at the last point", () => {
    const rows = [
      { t: "a", p: 5, q: 5 },
      { t: "b", p: 10, q: 10 },
    ];
    const { container } = render(<UiChart kind="area" data={rows} x="t" series={["p", "q"]} stacked />);
    // The axis runs 0–20 (zero-based, a stack); p's band is 0–10 at the end, so its label sits at 5, q's at 15.
    const y = (v: number) => tickY(container, "0") + ((tickY(container, "20") - tickY(container, "0")) * v) / 20;
    const [p, q] = [...container.querySelectorAll('[data-part="end-label"]')].map((e) => Number(e.getAttribute("y")));
    expect(Math.abs(p - y(5))).toBeLessThan(1);
    expect(Math.abs(q - y(15))).toBeLessThan(1);
  });

  it("keeps bars bare by default and puts the value at the tip when asked", () => {
    expect(readLabels(undefined, "bar")).toBe("none");
    expect(readLabels(undefined, "dumbbell")).toBe("ends");
    const { container, unmount } = render(<UiChart kind="bar" data={weeks} x="week" series={["api"]} labels="ends" />);
    const labels = [...container.querySelectorAll('[data-part="value-label"]')];
    expect(labels.map((e) => e.textContent)).toEqual(["120", "140", "133"]);
    // Columns take their value on the cap.
    labels.forEach((l, i) => expect(Number(l.getAttribute("y"))).toBeLessThan(boxOf(bars(container)[i]).y));
    unmount();
    const stack = render(<UiChart kind="bar" data={weeks} x="week" series={three} stacked labels="ends" />);
    expect([...stack.container.querySelectorAll('[data-part="value-label"]')].map((e) => e.textContent)).toEqual(["230", "277", "281"]);
  });

  it("labels stacked segments inside only where the value fits", () => {
    const rows = [{ q: "Q1", a: 500, b: 3 }];
    const { container } = render(<UiChart kind="bar" data={rows} x="q" series={["a", "b"]} stacked labels="all" orientation="horizontal" />);
    const texts = [...container.querySelectorAll('[data-part="value-label"]')].map((e) => e.textContent);
    // The total at the tip, a's value inside its long segment; b's sliver gets none (the tooltip and table have it).
    expect(texts).toContain("503");
    expect(texts).toContain("500");
    expect(texts).not.toContain("3");
  });
});

describe("keyboard, hover and table", () => {
  it("is one tab stop; arrows move between categories and the tooltip shows on focus, as on hover", async () => {
    const user = userEvent.setup();
    render(<UiChart kind="line" data={weeks} x="week" series={three} />);
    await user.tab();
    await user.tab();
    await user.tab();
    const items = screen.getAllByRole("listitem").filter((r) => r.hasAttribute("data-index"));
    expect(items.filter((i) => i.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(items[0]).toHaveFocus();
    expect(items[0].getAttribute("aria-label")).toBe("W1: API 120, Web 80, Jobs 30");
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("W1");
    expect(tip).toHaveTextContent("120");
    expect(items[0]).toHaveAttribute("aria-describedby", tip.id);
    // The crosshair finds the x and every series' point on it.
    const cross = document.querySelector('[data-part="crosshair"]')!;
    const dot = document.querySelector('[data-series="series-0"] [data-mark="dot"]')!;
    expect(cross.getAttribute("x1")).toBe(dot.getAttribute("cx"));
    expect(document.querySelectorAll('[data-part="active"] circle')).toHaveLength(3);
    await user.keyboard("{ArrowRight}");
    expect(items[1]).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("W2");
    await user.keyboard("{End}");
    expect(items[2]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(items[0]).toHaveFocus();
  });

  it("names the figure and gives each category a hit target bigger than its marks", () => {
    const { container } = render(<UiChart kind="bar" data={weeks} x="week" series={three} />);
    expect(screen.getByRole("list", { name: "Bar chart: API, Web, Jobs by week" })).toBe(svgOf(container));
    for (const h of container.querySelectorAll('[data-part="hit"]')) expect(Number(h.getAttribute("width"))).toBeGreaterThanOrEqual(24);
  });

  it("lifts the hovered bars' category and lists every series with the stack's total", async () => {
    const user = userEvent.setup();
    const { container } = render(<UiChart kind="bar" data={weeks} x="week" series={three} stacked />);
    expect(container.querySelector('[data-part="hover"]')).toBeNull();
    await user.hover(container.querySelector('[data-index="1"][role="listitem"]')!);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("W2");
    expect(tip).toHaveTextContent("140API");
    expect(tip).toHaveTextContent("277total");
    expect(container.querySelector('[data-part="hover"]')).not.toBeNull();
    await user.unhover(container.querySelector(".ui-chart [data-grow], .ui-chart .relative")!);
  });

  it("flips to a table of the data", async () => {
    const user = userEvent.setup();
    render(<UiChart kind="line" data={weeks} x="week" series={three} unit="ms" />);
    await user.click(screen.getByRole("button", { name: "table" }));
    const table = screen.getByRole("table");
    expect(within(table).getByText("week")).toBeInTheDocument();
    expect(within(table).getByText("140 ms")).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(4);
  });

  it("fills the Expand dialog, and keeps its height inline", () => {
    const inline = render(<UiChart kind="line" data={weeks} x="week" series={three} />);
    expect(inline.container.querySelector("[data-grow]")).toBeNull();
    inline.unmount();
    const big = render(
      <UiViewContext.Provider value={{ expanded: true }}>
        <UiChart kind="line" data={weeks} x="week" series={three} />
      </UiViewContext.Provider>,
    );
    const box = big.container.querySelector<HTMLElement>("[data-grow]")!;
    expect(box.getAttribute("data-grow")).toBe("fill");
    expect(box.className).toContain("flex-1");
    expect(box.querySelector("svg")).not.toBeNull();
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
  it("starts bars at zero and fits a line to its data", () => {
    const index = [100, 104.8, 112.3, 118.1].map((close, i) => ({ m: `M${i}`, close }));
    const bar = render(<UiChart kind="bar" data={index} x="m" series={["close"]} />);
    expect(ticks(bar.container)[0]).toBe("0");
    bar.unmount();
    const line = render(<UiChart kind="line" data={index} x="m" series={["close"]} refs={[{ axis: "y", value: 100, label: "Start" }]} />);
    const ys = ticks(line.container).map(Number);
    expect(ys[0]).toBeGreaterThan(80);
    expect(ys[0]).toBeLessThanOrEqual(100);
    expect(ys[ys.length - 1]).toBeGreaterThanOrEqual(118.1);
    line.unmount();
    const zero = render(<UiChart kind="line" data={index} x="m" series={["close"]} zero />);
    expect(ticks(zero.container)[0]).toBe("0");
  });

  it("takes zero and domain from an agent's tree, not only from direct props", async () => {
    const tree = {
      type: "chart",
      props: {
        kind: "line",
        data: [
          { m: "a", v: 40 },
          { m: "b", v: 60 },
        ],
        x: "m",
        series: ["v"],
        domain: [0, 200],
      },
    };
    const { container } = render(<UiTree tree={tree} props={{}} />);
    await waitFor(() => expect(container.querySelector('[data-axis="value"]')).not.toBeNull());
    const t = ticks(container);
    expect(t[0]).toBe("0");
    expect(t[t.length - 1]).toBe("200");
  });

  it("never wraps a tick label, and makes the axis wide enough for it", () => {
    const temps = [-8, 0, 18, 30].map((t, i) => ({ m: `M${i}`, t }));
    const { container, unmount } = render(<UiChart kind="line" data={temps} x="m" series={["t"]} unit=" °C" />);
    const labels = [...container.querySelectorAll('[data-axis="value"] [data-part="tick"]')];
    expect(labels.map((t) => t.textContent)).toContain("-10 °C");
    for (const t of labels) expect(t.querySelectorAll("tspan")).toHaveLength(0);
    unmount();
    // "100%" isn't clipped either: the axis is as wide as its widest tick.
    const share = [{ m: "a", s: 60, o: 40 }];
    const stacked = render(<UiChart kind="area" stacked data={share} x="m" series={["s", "o"]} unit="%" />);
    const top = [...stacked.container.querySelectorAll('[data-axis="value"] [data-part="tick"]')].find((t) => t.textContent === "100%")!;
    expect(top).toBeDefined();
    // Right-aligned at x: the text (4 characters at 12px) has room to its left.
    expect(top).toHaveAttribute("text-anchor", "end");
    expect(Number(top.getAttribute("x"))).toBeGreaterThanOrEqual(4 * 12 * 0.6);
  });

  it("thins category labels on a long line so they never overlap, keeping the first and last", () => {
    const days = Array.from({ length: 60 }, (_, i) => ({ d: `Day ${i + 1}`, v: i }));
    const { container } = render(<UiChart kind="line" data={days} x="d" series={["v"]} />);
    const shown = ticks(container, "category");
    expect(shown.length).toBeLessThan(60);
    expect(shown[0]).toBe("Day 1");
    expect(shown[shown.length - 1]).toBe("Day 60");
    // Long series draw no dots (only the active one on hover).
    expect(container.querySelectorAll('[data-mark="dot"]')).toHaveLength(0);
  });

  it("sizes chart text from the interface font size, never under 11px", () => {
    const root = document.documentElement;
    const tickSize = () => {
      const v = render(<UiChart kind="line" data={weeks} x="week" series={three} />);
      const size = v.container.querySelector('[data-part="tick"]')!.getAttribute("font-size");
      v.unmount();
      return Number(size);
    };
    expect(tickSize()).toBe(12);
    root.style.fontSize = "20px";
    try {
      expect(tickSize()).toBe(15);
      root.style.fontSize = "12px";
      expect(tickSize()).toBe(11);
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

  it("draws sorted bars in that order", () => {
    const { container } = render(<UiChart kind="bar" data={weeks} x="week" series={three} sort="value" />);
    expect(ticks(container, "category")).toEqual(["W3", "W2", "W1"]);
  });
});

it("never draws text in a series colour", () => {
  for (const kind of ["bar", "line", "area"] as const) {
    const { container, unmount } = render(
      <UiChart
        kind={kind}
        data={weeks}
        x="week"
        series={three}
        labels="all"
        stacked={kind !== "line"}
        refs={[{ axis: "y", value: 100, label: "Target" }]}
      />,
    );
    for (const t of svgOf(container).querySelectorAll("text")) expect(t.getAttribute("fill") ?? "", kind).not.toMatch(/--color-|--chart-/);
    unmount();
  }
});
