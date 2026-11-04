// Split panes: the main area as a tree of row and column splits (Ghostty-style),
// each leaf a pane showing a chat, a project, the component library, a picker or
// the home screen. Pure functions over plain data; the app keeps the tree in
// use-yaah.ts and Rust saves it (settings.rs `layout`, checked and pruned by layout.rs).

/** What a pane shows; null is the home screen. */
/**
 * What a pane shows; null is the home screen. A terminal is a shell in `cwd` (the default folder
 * when there is none); `id` is its running shell, which a restart leaves naming nothing.
 */
export type Selection =
  | { kind: "project"; id: string }
  | { kind: "chat"; id: string }
  | { kind: "components" }
  | { kind: "picker" }
  | { kind: "terminal"; cwd?: string; id?: string }
  | { kind: "diff"; cwd?: string; mode?: DiffMode; base?: string }
  | null;

/**
 * What a diff pane compares: the working tree against HEAD (`all`), the staged changes, the unstaged ones,
 * or the working tree against its merge base with a branch (`base`). Rust reads it (sources/git.rs `working_view`).
 */
export type DiffMode = "all" | "staged" | "unstaged" | "branch";

export type Pane = { type: "pane"; id: string; content: Selection };
/** `row`: `a` left of `b`; `column`: `a` above `b`. `ratio` is `a`'s share. */
export type Split = { type: "split"; id: string; dir: "row" | "column"; ratio: number; a: LayoutNode; b: LayoutNode };
export type LayoutNode = Pane | Split;
export type Layout = { root: LayoutNode; focused: string };
export type Direction = "left" | "right" | "up" | "down";
/** A box in the main area, as fractions of it (0–1). */
export type Rect = { x: number; y: number; w: number; h: number };

/**
 * Narrowest and shortest a pane gets when dragging a divider, in CSS pixels at the default interface
 * size (17.5rem × 10rem). It grows with the interface size (the `scale` of `clampRatio`, which panes.tsx
 * reads off the root font size, Settings → Fonts), so a pane at 20px keeps room for its header. Rust
 * (layout.rs) only bounds ratios and never sees pixels, so it has nothing to keep in step.
 */
export const MIN_PANE = { w: 280, h: 160 };
/** A divider's share never goes past these, whatever the size. */
const RATIO_MIN = 0.05;
export const MAX_PANES = 16;

export const singlePane = (content: Selection = null): Layout => ({ root: { type: "pane", id: "p1", content }, focused: "p1" });

/** Panes in reading order (left to right, top to bottom within each split). */
export function panesOf(node: LayoutNode): Pane[] {
  return node.type === "pane" ? [node] : [...panesOf(node.a), ...panesOf(node.b)];
}

export const findPane = (layout: Layout, id: string): Pane | undefined => panesOf(layout.root).find((p) => p.id === id);

/** The focused pane (the first one if the focus points nowhere). */
export const focusedPane = (layout: Layout): Pane => findPane(layout, layout.focused) ?? panesOf(layout.root)[0];

function ids(node: LayoutNode): string[] {
  return node.type === "pane" ? [node.id] : [node.id, ...ids(node.a), ...ids(node.b)];
}

/** `p7`, `s3`: one past the highest id with that prefix. */
function freshId(root: LayoutNode, prefix: "p" | "s"): string {
  const n = Math.max(0, ...ids(root).map((id) => (id.startsWith(prefix) ? Number(id.slice(1)) || 0 : 0)));
  return `${prefix}${n + 1}`;
}

/** The tree with `f` applied to each node bottom-up (return the node itself to keep it). */
function mapTree(node: LayoutNode, f: (n: LayoutNode) => LayoutNode): LayoutNode {
  if (node.type === "pane") return f(node);
  const a = mapTree(node.a, f);
  const b = mapTree(node.b, f);
  return f(a === node.a && b === node.b ? node : { ...node, a, b });
}

/**
 * Split pane `id` in two: `row` puts the new pane to its right, `column` below it.
 * The new pane shows `content` (the picker by default) and takes the focus.
 */
export function splitPane(layout: Layout, id: string, dir: Split["dir"], content: Selection = { kind: "picker" }): { layout: Layout; id: string } {
  if (panesOf(layout.root).length >= MAX_PANES || !findPane(layout, id)) return { layout, id: layout.focused };
  const fresh = freshId(layout.root, "p");
  const splitId = freshId(layout.root, "s");
  const root = mapTree(layout.root, (n) =>
    n.type === "pane" && n.id === id ? { type: "split", id: splitId, dir, ratio: 0.5, a: n, b: { type: "pane", id: fresh, content } } : n,
  );
  return { layout: { root, focused: fresh }, id: fresh };
}

/**
 * Close pane `id`: its sibling takes the space. The last pane stays (the layout comes
 * back unchanged). A closed focused pane hands the focus to the nearest pane that grew.
 */
export function closePane(layout: Layout, id: string): Layout {
  if (layout.root.type === "pane") return layout;
  const before = paneRects(layout.root);
  const gone = before.get(id);
  if (!gone) return layout;
  let heir: LayoutNode | null = null;
  const root = mapTree(layout.root, (n) => {
    if (n.type !== "split") return n;
    if (n.a.type === "pane" && n.a.id === id) return (heir = n.b);
    if (n.b.type === "pane" && n.b.id === id) return (heir = n.a);
    return n;
  });
  if (!heir) return layout;
  let focused = layout.focused;
  if (focused === id) {
    const centre = { x: gone.x + gone.w / 2, y: gone.y + gone.h / 2 };
    const dist = (r: Rect) => Math.hypot(r.x + r.w / 2 - centre.x, r.y + r.h / 2 - centre.y);
    focused = panesOf(heir)
      .map((p) => p.id)
      .sort((x, y) => dist(before.get(x)!) - dist(before.get(y)!))[0];
  }
  return { root, focused };
}

export function setContent(layout: Layout, id: string, content: Selection): Layout {
  const pane = findPane(layout, id);
  if (!pane || sameContent(pane.content, content)) return layout;
  return { ...layout, root: mapTree(layout.root, (n) => (n.type === "pane" && n.id === id ? { ...n, content } : n)) };
}

/** Every pane's content through `f` (e.g. a deleted chat's panes go back to its project). */
export function mapContents(layout: Layout, f: (c: Selection) => Selection): Layout {
  let changed = false;
  const root = mapTree(layout.root, (n) => {
    if (n.type !== "pane") return n;
    const content = f(n.content);
    if (sameContent(content, n.content)) return n;
    changed = true;
    return { ...n, content };
  });
  return changed ? { ...layout, root } : layout;
}

export function setRatio(layout: Layout, splitId: string, ratio: number): Layout {
  const r = clamp(ratio, RATIO_MIN, 1 - RATIO_MIN);
  return { ...layout, root: mapTree(layout.root, (n) => (n.type === "split" && n.id === splitId && n.ratio !== r ? { ...n, ratio: r } : n)) };
}

/** How many panes sit side by side (`row`) or stacked (`column`) along `dir`: a split the other way counts once. */
function panesAlong(node: LayoutNode, dir: Split["dir"]): number {
  return node.type === "split" && node.dir === dir ? panesAlong(node.a, dir) + panesAlong(node.b, dir) : 1;
}

/**
 * Every pane the same share of its row or column, as Ghostty's "equalize splits" does: each
 * divider moves to the share of panes on its side, so three side by side get a third each.
 */
export function balance(layout: Layout): Layout {
  const even = (n: LayoutNode): LayoutNode => {
    if (n.type !== "split") return n;
    const a = even(n.a);
    const b = even(n.b);
    const before = panesAlong(n.a, n.dir);
    const ratio = clamp(before / (before + panesAlong(n.b, n.dir)), RATIO_MIN, 1 - RATIO_MIN);
    return a === n.a && b === n.b && ratio === n.ratio ? n : { ...n, ratio, a, b };
  };
  const root = even(layout.root);
  return root === layout.root ? layout : { ...layout, root };
}

export const focusPane = (layout: Layout, id: string): Layout =>
  layout.focused === id || !findPane(layout, id) ? layout : { ...layout, focused: id };

export function sameContent(a: Selection, b: Selection): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "terminal") return b.kind === "terminal" && a.id === b.id && a.cwd === b.cwd;
  if (a.kind === "diff") return b.kind === "diff" && a.cwd === b.cwd && a.mode === b.mode && a.base === b.base;
  return !("id" in a) || a.id === (b as { id: string }).id;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Where each pane sits, as fractions of the main area. */
export function paneRects(root: LayoutNode, at: Rect = { x: 0, y: 0, w: 1, h: 1 }, out = new Map<string, Rect>()): Map<string, Rect> {
  if (root.type === "pane") return out.set(root.id, at);
  const [ra, rb] = halves(root, at);
  paneRects(root.a, ra, out);
  return paneRects(root.b, rb, out);
}

/** Every split with the box it divides, outermost first: where the dividers go. */
export function splitRects(root: LayoutNode, at: Rect = { x: 0, y: 0, w: 1, h: 1 }): { split: Split; rect: Rect }[] {
  if (root.type === "pane") return [];
  const [ra, rb] = halves(root, at);
  return [{ split: root, rect: at }, ...splitRects(root.a, ra), ...splitRects(root.b, rb)];
}

function halves(s: Split, r: Rect): [Rect, Rect] {
  if (s.dir === "row") {
    const w = r.w * s.ratio;
    return [
      { ...r, w },
      { ...r, x: r.x + w, w: r.w - w },
    ];
  }
  const h = r.h * s.ratio;
  return [
    { ...r, h },
    { ...r, y: r.y + h, h: r.h - h },
  ];
}

const EPS = 1e-6;

/** The pane next to `from` in direction `dir` (the closest edge, then the most shared border), if any. */
export function neighbour(layout: Layout, from: string, dir: Direction): string | null {
  const rects = paneRects(layout.root);
  const r = rects.get(from);
  if (!r) return null;
  const horizontal = dir === "left" || dir === "right";
  let best: { id: string; gap: number; overlap: number; offset: number } | null = null;
  for (const [id, c] of rects) {
    if (id === from) continue;
    const gap = dir === "right" ? c.x - (r.x + r.w) : dir === "left" ? r.x - (c.x + c.w) : dir === "down" ? c.y - (r.y + r.h) : r.y - (c.y + c.h);
    if (gap < -EPS) continue;
    // How much of the shared side they have in common.
    const overlap = horizontal ? Math.min(r.y + r.h, c.y + c.h) - Math.max(r.y, c.y) : Math.min(r.x + r.w, c.x + c.w) - Math.max(r.x, c.x);
    if (overlap <= EPS) continue;
    // Ties go to the pane level with the start of this one (top or left), as reading order would.
    const offset = horizontal ? Math.abs(c.y - r.y) : Math.abs(c.x - r.x);
    const better =
      !best ||
      gap < best.gap - EPS ||
      (Math.abs(gap - best.gap) <= EPS && (overlap > best.overlap + EPS || (Math.abs(overlap - best.overlap) <= EPS && offset < best.offset)));
    if (better) best = { id, gap, overlap, offset };
  }
  return best?.id ?? null;
}

/** The pane after `from` in reading order, wrapping around. */
export function nextPane(layout: Layout, from: string, step: 1 | -1 = 1): string {
  const list = panesOf(layout.root);
  const i = list.findIndex((p) => p.id === from);
  return list[(Math.max(0, i) + step + list.length) % list.length].id;
}

/** The least room a subtree needs along `axis` for each of its panes to keep `MIN_PANE`, times the interface `scale`. */
export function minExtent(node: LayoutNode, axis: "x" | "y", scale = 1): number {
  if (node.type === "pane") return (axis === "x" ? MIN_PANE.w : MIN_PANE.h) * scale;
  const along = (node.dir === "row") === (axis === "x");
  const a = minExtent(node.a, axis, scale);
  const b = minExtent(node.b, axis, scale);
  return along ? a + b : Math.max(a, b);
}

/**
 * The ratio a divider may take in a split `px` pixels long: both sides keep their panes'
 * minimum size (times `scale`, the interface size over its default) when there's room for it;
 * otherwise (or with no size yet) a plain bound.
 */
export function clampRatio(split: Split, ratio: number, px: number, scale = 1): number {
  const axis = split.dir === "row" ? "x" : "y";
  let lo = RATIO_MIN;
  let hi = 1 - RATIO_MIN;
  if (px > 0) {
    const a = minExtent(split.a, axis, scale) / px;
    const b = minExtent(split.b, axis, scale) / px;
    if (a + b <= 1) {
      lo = Math.max(lo, a);
      hi = Math.min(hi, 1 - b);
    }
  }
  return clamp(ratio, lo, hi);
}

/**
 * Without panes `keep` rejects (a deleted chat or project), their siblings taking the
 * space; a single home pane when nothing is left. Mirrors layout.rs `pruned`.
 */
export function prune(layout: Layout, keep: (c: Selection) => boolean): Layout {
  const walk = (n: LayoutNode): LayoutNode | null => {
    if (n.type === "pane") return keep(n.content) ? n : null;
    const a = walk(n.a);
    const b = walk(n.b);
    if (a && b) return a === n.a && b === n.b ? n : { ...n, a, b };
    return a ?? b;
  };
  const root = walk(layout.root);
  if (!root) return singlePane();
  if (root === layout.root) return layout;
  return { root, focused: panesOf(root).some((p) => p.id === layout.focused) ? layout.focused : panesOf(root)[0].id };
}
