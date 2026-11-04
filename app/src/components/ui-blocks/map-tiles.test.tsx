// The street map (`kind: "markers"`, Leaflet): in a dark theme its tiles are inverted by a CSS
// filter (no second tile host); expanded, it takes the dialog's height and never squashes under
// its inline height (the 252px map the gallery found); inline, a flex column can't shrink it.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import UiMap from "@/components/ui-blocks/map";
import { UiViewContext } from "@/components/ui-view";
import { readIndexCss } from "@/test/css-tokens";

const markers = [
  { lat: 38.72, lng: -9.14, label: "Lisbon" },
  { lat: 52.52, lng: 13.4, label: "Berlin" },
];

describe("the street map", () => {
  it("inverts only the tile pane in a dark theme", async () => {
    const css = await readIndexCss();
    const rule = /\.dark \.ui-map-tiles \.leaflet-tile-pane\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/filter:\s*invert\(1\) hue-rotate\(180deg\)/);
    const { container } = render(<UiMap markers={markers} height={300} />);
    expect(container.querySelector(".ui-map-tiles .leaflet-tile-pane")).not.toBeNull();
    // Markers are drawn in the overlay pane, outside the filtered one.
    expect(container.querySelector(".leaflet-tile-pane .leaflet-interactive")).toBeNull();
  });

  it("keeps its height inline and can't be squashed by a flex column", () => {
    render(<UiMap markers={markers} height={300} />);
    const box = screen.getByRole("region", { name: "Map, 2 places" });
    expect(box.style.height).toBe("300px");
    expect(box.className).toContain("shrink-0");
    expect(box).not.toHaveAttribute("data-grow");
  });

  it("fills the Expand dialog, at least as tall as inline", () => {
    render(
      <UiViewContext.Provider value={{ expanded: true }}>
        <UiMap markers={markers} />
      </UiViewContext.Provider>,
    );
    const box = screen.getByRole("region", { name: "Map, 2 places" });
    expect(box).toHaveAttribute("data-grow", "fill");
    expect(box.className).toContain("flex-1");
    expect(box.className).toContain("overflow-hidden");
    expect(box.style.minHeight).toBe("320px");
    expect(box.style.height).toBe("");
  });

  it("draws routes from coordinates or marker ids, each named for the keyboard", () => {
    const { container } = render(
      <UiMap
        markers={[
          { id: "a", lat: 38.72, lng: -9.14, label: "Depot" },
          { id: "b", lat: 38.75, lng: -9.1, label: "Stop 1" },
        ]}
        lines={[{ points: ["a", "b", [38.7, -9.2]], label: "Morning round" }, { points: [[38.7, -9.1]] }, { points: ["a", "nope"] }]}
      />,
    );
    // One route (the others have fewer than two places): a casing and the line itself.
    const named = container.querySelectorAll('path[aria-label="Morning round, 3 stops"]');
    expect(named).toHaveLength(1);
    expect(named[0]).toHaveAttribute("tabindex", "0");
  });

  it("groups 60 close markers into clusters named by their count, and leaves far-off ones out of the fit", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      lat: 48.85 + (i % 6) * 0.001,
      lng: 2.35 + Math.floor(i / 6) * 0.001,
      label: `M${i}`,
      tone: i === 3 ? "danger" : "default",
    }));
    const { container } = render(<UiMap markers={[...many, { lat: -33.9, lng: 151.2, label: "Sydney" }]} cluster />);
    const clusters = [...container.querySelectorAll("[data-cluster]")];
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters.reduce((n, c) => n + Number(c.getAttribute("data-cluster")), 0)).toBeGreaterThanOrEqual(60);
    expect(clusters.some((c) => /problem/.test(c.getAttribute("aria-label") ?? ""))).toBe(true);
    expect(screen.getByRole("button", { name: /1 outside view/ })).toBeInTheDocument();
  });
});
