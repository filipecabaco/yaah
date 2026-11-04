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
});
