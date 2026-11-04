// The chart's value axis and unit rules, without a renderer.
import { describe, expect, it } from "vitest";
import { formatter, normalise, readDomain, valueAxis, withUnit, type Ref } from "@/components/ui-blocks/chart-model";

const rows = (values: number[]) =>
  normalise(
    values.map((v, i) => ({ t: i, v })),
    ["v"],
    "t",
  );

describe("value axis", () => {
  const axis = (
    kind: "bar" | "line" | "area",
    values: number[],
    extra: { stacked?: boolean; refs?: Ref[]; zero?: boolean; domain?: [number, number] } = {},
  ) => {
    const { data, series } = rows(values);
    return valueAxis({ kind, stacked: !!extra.stacked, data, series, refs: extra.refs ?? [], zero: extra.zero, domain: extra.domain });
  };
  const finance = [100, 102.4, 101.1, 104.8, 107.2, 105.6, 109.9, 112.3, 110.4, 114.8, 118.1, 116.5];

  it("keeps bars at zero", () => {
    expect(axis("bar", finance).domain[0]).toBe(0);
    expect(axis("bar", finance).zeroBased).toBe(true);
    expect(axis("bar", [-3, 5]).domain).toEqual([-4, 6]);
  });

  it("fits a line to its data, out to nice ticks, with its refs", () => {
    const a = axis("line", finance, { refs: [{ axis: "y", value: 100 }] });
    expect(a.zeroBased).toBe(false);
    // The ref at 100 would sit on the plot's border: one more step below it.
    expect(a.domain).toEqual([95, 120]);
    expect(a.ticks[0]).toBe(95);
    expect(axis("line", finance).domain).toEqual([100, 120]);
    // A ref outside the data widens it.
    expect(axis("line", finance, { refs: [{ axis: "y", value: 80 }] }).domain[0]).toBeLessThanOrEqual(80);
    // Padded to nice ticks, never across zero; a flat line gets a range around it.
    expect(axis("line", [3, 47]).domain).toEqual([0, 50]);
    expect(axis("line", [12, 12]).domain[0]).toBeGreaterThan(0);
  });

  it("includes zero when the data crosses it", () => {
    const climate = axis("line", [-4, 0, 18, 30]);
    expect(climate.domain[0]).toBeLessThan(-4);
    expect(climate.ticks).toContain(0);
  });

  it("honours `zero: true` and `domain` on lines and unstacked areas", () => {
    expect(axis("line", finance, { zero: true }).domain[0]).toBe(0);
    expect(axis("area", finance, { domain: [90, 130] }).domain).toEqual([90, 130]);
    // A domain that would cut the data off is widened to it.
    expect(axis("line", finance, { domain: [100, 110] }).domain[1]).toBeGreaterThanOrEqual(118.1);
    expect(readDomain([0, 100])).toEqual([0, 100]);
    expect(readDomain([5, 1])).toBeUndefined();
    expect(readDomain("0-100")).toBeUndefined();
  });

  it("stacks from zero up to the biggest total", () => {
    const { data, series } = normalise(
      [
        { t: 1, a: 60, b: 40 },
        { t: 2, a: 50, b: 30 },
      ],
      ["a", "b"],
      "t",
    );
    const a = valueAxis({ kind: "area", stacked: true, data, series, refs: [] });
    expect(a.domain).toEqual([0, 100]);
    expect(a.ticks[a.ticks.length - 1]).toBe(100);
  });
});

describe("units", () => {
  it("attaches symbols and magnitude suffixes, spaces words, and keeps the agent's own spacing", () => {
    expect(formatter("k")(16)).toBe("16k");
    expect(formatter("k")(0)).toBe("0");
    expect(formatter("%")(0)).toBe("0%");
    expect(formatter("M")(2.5)).toBe("2.5M");
    expect(formatter("%")(77)).toBe("77%");
    expect(formatter("°")(30)).toBe("30°");
    expect(formatter("°C")(21)).toBe("21°C");
    expect(formatter(" °C")(-10)).toBe("-10 °C");
    expect(formatter(" pts")(12)).toBe("12 pts");
    expect(formatter(" req")(3)).toBe("3 req");
    expect(formatter("ms")(42)).toBe("42 ms");
    expect(formatter("$")(12)).toBe("$12");
    expect(formatter("$")(-12)).toBe("-$12");
    expect(withUnit("4", undefined)).toBe("4");
  });
});
