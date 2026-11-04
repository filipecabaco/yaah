import { describe, expect, it } from "vitest";
import {
  balance,
  clampRatio,
  closePane,
  focusPane,
  MAX_PANES,
  mapContents,
  MIN_PANE,
  minExtent,
  neighbour,
  nextPane,
  paneRects,
  panesOf,
  prune,
  setRatio,
  singlePane,
  splitPane,
  splitRects,
  type Layout,
  type Split,
} from "@/lib/layout";

const chat = (id: string) => ({ kind: "chat", id }) as const;

/** p1 | p2, then p2 split downward: p1 | (p2 / p3). */
function threePanes(): Layout {
  let l = singlePane(chat("a"));
  l = splitPane(l, "p1", "row").layout;
  l = splitPane(l, "p2", "column").layout;
  return l;
}

describe("splitting", () => {
  it("puts the new pane right of or below the focused one, on the picker, with the focus", () => {
    const { layout, id } = splitPane(singlePane(chat("a")), "p1", "row");
    expect(id).toBe("p2");
    expect(layout.focused).toBe("p2");
    expect(layout.root).toMatchObject({
      type: "split",
      dir: "row",
      ratio: 0.5,
      a: { id: "p1", content: chat("a") },
      b: { id: "p2", content: { kind: "picker" } },
    });

    const down = splitPane(layout, "p2", "column");
    expect(down.id).toBe("p3");
    expect(paneRects(down.layout.root)).toEqual(
      new Map([
        ["p1", { x: 0, y: 0, w: 0.5, h: 1 }],
        ["p2", { x: 0.5, y: 0, w: 0.5, h: 0.5 }],
        ["p3", { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }],
      ]),
    );
    expect(splitRects(down.layout.root).map((s) => [s.split.id, s.rect])).toEqual([
      ["s1", { x: 0, y: 0, w: 1, h: 1 }],
      ["s2", { x: 0.5, y: 0, w: 0.5, h: 1 }],
    ]);
  });

  it("stops at the most panes there can be", () => {
    let l = singlePane();
    for (let i = 1; i < MAX_PANES + 3; i++) l = splitPane(l, l.focused, i % 2 ? "row" : "column").layout;
    expect(panesOf(l.root)).toHaveLength(MAX_PANES);
  });
});

describe("closing", () => {
  it("gives the space to the sibling and the focus to the nearest pane that grew", () => {
    const l = threePanes();
    const closed = closePane(l, "p3");
    expect(panesOf(closed.root).map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(closed.focused).toBe("p2");
    // Closing the left pane: the right column takes the whole width, focus stays where it was.
    const left = closePane(focusPane(l, "p3"), "p1");
    expect(left.root).toMatchObject({ type: "split", id: "s2", dir: "column" });
    expect(left.focused).toBe("p3");
    // Closing a focused pane whose sibling is a split: the pane of it closest to where it was.
    const wide = closePane(focusPane(l, "p1"), "p1");
    expect(["p2", "p3"]).toContain(wide.focused);
  });

  it("keeps the last pane", () => {
    const one = singlePane(chat("a"));
    expect(closePane(one, "p1")).toBe(one);
  });
});

describe("moving the focus", () => {
  it("goes to the neighbour in each direction, or nowhere", () => {
    const l = threePanes();
    expect(neighbour(l, "p1", "right")).toBe("p2");
    expect(neighbour(l, "p3", "left")).toBe("p1");
    expect(neighbour(l, "p2", "down")).toBe("p3");
    expect(neighbour(l, "p3", "up")).toBe("p2");
    expect(neighbour(l, "p1", "left")).toBeNull();
    expect(neighbour(l, "p2", "right")).toBeNull();
    expect(neighbour(l, "p1", "up")).toBeNull();
  });

  it("prefers the pane sharing most of the edge", () => {
    // p1 | p2 with p2 split at 80 %: from p1, right goes to the big top one.
    let l = threePanes();
    l = setRatio(l, "s2", 0.8);
    expect(neighbour(l, "p1", "right")).toBe("p2");
    l = setRatio(l, "s2", 0.2);
    expect(neighbour(l, "p1", "right")).toBe("p3");
  });

  it("cycles in reading order", () => {
    const l = threePanes();
    expect(nextPane(l, "p1")).toBe("p2");
    expect(nextPane(l, "p3")).toBe("p1");
    expect(nextPane(l, "p1", -1)).toBe("p3");
  });
});

describe("contents and sizes", () => {
  it("maps contents, keeping the same layout when nothing changes", () => {
    const l = threePanes();
    expect(mapContents(l, (c) => c)).toBe(l);
    const gone = mapContents(l, (c) => (c?.kind === "chat" && c.id === "a" ? null : c));
    expect(panesOf(gone.root)[0].content).toBeNull();
  });

  it("keeps each side of a divider at least a pane wide when there's room", () => {
    const s = threePanes().root as Split;
    // p1 | (p2 / p3): each side needs one pane's width.
    expect(minExtent(s, "x")).toBe(2 * MIN_PANE.w);
    expect(minExtent(s, "y")).toBe(2 * MIN_PANE.h);
    expect(clampRatio(s, 0.01, 1000)).toBeCloseTo(MIN_PANE.w / 1000);
    expect(clampRatio(s, 0.99, 1000)).toBeCloseTo(1 - MIN_PANE.w / 1000);
    expect(clampRatio(s, 0.5, 1000)).toBe(0.5);
    // Too small for both minimums (or not measured): only the plain bounds.
    expect(clampRatio(s, 0.01, 300)).toBe(0.05);
    expect(clampRatio(s, 0.99, 0)).toBe(0.95);
    expect((setRatio(threePanes(), "s1", 2).root as Split).ratio).toBe(0.95);
  });

  it("grows the pane minimum with the interface size (LV-1: 20px is a scale of 20/14)", () => {
    const s = threePanes().root as Split;
    const scale = 20 / 14;
    expect(minExtent(s, "x", scale)).toBeCloseTo(2 * MIN_PANE.w * scale);
    expect(clampRatio(s, 0.01, 1000, scale)).toBeCloseTo((MIN_PANE.w * scale) / 1000);
    expect(clampRatio(s, 0.99, 1000, scale)).toBeCloseTo(1 - (MIN_PANE.w * scale) / 1000);
    // 2 × 400px no longer fits in 700px: only the plain bounds.
    expect(clampRatio(s, 0.01, 700, scale)).toBe(0.05);
  });
});

describe("balancing", () => {
  const widths = (l: Layout) => [...paneRects(l.root).values()].map((r) => +r.w.toFixed(4));

  it("gives three panes side by side a third each, however they were split", () => {
    // p1 | (p2 | p3), dragged lopsided: the outer divider counts the two panes on its right.
    let l = splitPane(singlePane(chat("a")), "p1", "row").layout;
    l = splitPane(l, "p2", "row").layout;
    l = setRatio(setRatio(l, "s1", 0.8), "s2", 0.3);
    const even = balance(l);
    expect(widths(even)).toEqual([0.3333, 0.3333, 0.3333]);
    expect((even.root as Split).ratio).toBeCloseTo(1 / 3);
  });

  it("evens a column inside a row on its own axis: p1 | (p2 / p3)", () => {
    const l = setRatio(setRatio(threePanes(), "s1", 0.7), "s2", 0.2);
    const rects = [...paneRects(balance(l).root).values()];
    expect(rects.map((r) => +r.w.toFixed(4))).toEqual([0.5, 0.5, 0.5]);
    expect(rects.slice(1).map((r) => +r.h.toFixed(4))).toEqual([0.5, 0.5]);
  });

  it("keeps the panes, contents and focus, and returns the same layout when already even", () => {
    const l = setRatio(threePanes(), "s1", 0.7);
    const even = balance(l);
    expect(panesOf(even.root)).toEqual(panesOf(l.root));
    expect(even.focused).toBe(l.focused);
    expect(balance(even)).toBe(even);
    const one = singlePane(chat("a"));
    expect(balance(one)).toBe(one);
  });
});

describe("pruning (as layout.rs does on load)", () => {
  it("drops panes whose chat or project is gone", () => {
    const l = focusPane(threePanes(), "p1");
    const after = prune(l, (c) => c?.kind !== "chat");
    expect(panesOf(after.root).map((p) => p.id)).toEqual(["p2", "p3"]);
    expect(after.focused).toBe("p2");
    expect(prune(l, () => false)).toEqual(singlePane());
    expect(prune(l, () => true)).toBe(l);
  });
});
