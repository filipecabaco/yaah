// The main area as split panes (src/lib/layout.ts). Every pane is laid out
// absolutely from the tree's geometry, keyed by its id, so splitting, closing and
// resizing never remount what a pane shows: its chat keeps its scroll position,
// its composer its draft. Dividers sit over the seams and resize by drag or keys.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { Hint } from "@/components/shortcuts";
import { Button } from "@/components/ui/button";
import { clampRatio, paneRects, panesOf, setRatio, splitRects, type Layout, type Rect, type Split } from "@/lib/layout";
import { cn } from "@/lib/utils";

/** How far one arrow key moves a divider (Shift: further), as a share of its split. */
const STEP = 0.02;
const BIG_STEP = 0.1;

/** The interface size over its default (the root font size over 16px): pane minimums grow with it. */
const interfaceScale = () => parseFloat(getComputedStyle(document.documentElement).fontSize) / 16 || 1;

const box = (r: Rect): CSSProperties => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });

export function PaneGrid({
  layout,
  contents,
  labels,
  onFocus,
  onResize,
  onClose,
}: {
  layout: Layout;
  /** What each pane shows, built by the app; the same elements while only a divider moves, so nothing inside re-renders. */
  contents: Record<string, ReactNode>;
  /** Each pane's accessible name ("Chat: …"), when there's more than one. */
  labels: Record<string, string>;
  onFocus: (id: string) => void;
  /** A divider's new ratio, once the drag ends (or per key). */
  onResize: (splitId: string, ratio: number) => void;
  /** The close button on a pane (there are several, and it isn't a terminal, diff or UI, which have their own). */
  onClose: (id: string) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A drag in progress moves only this view; the layout gets the ratio when it ends.
  const [drag, setDrag] = useState<{ id: string; ratio: number } | null>(null);
  const root = drag ? setRatio(layout, drag.id, drag.ratio).root : layout.root;
  const rects = paneRects(root);
  const panes = panesOf(root);
  const many = panes.length > 1;

  return (
    <div ref={grid} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
      {panes.map((p) => {
        const focused = p.id === layout.focused;
        return (
          <section
            key={p.id}
            data-pane-id={p.id}
            data-focused={focused || undefined}
            data-many={many || undefined}
            aria-label={many ? labels[p.id] : undefined}
            tabIndex={-1}
            className="group/pane absolute flex overflow-hidden outline-none"
            style={box(rects.get(p.id)!)}
            // The close button acts on its own pane without first making it the focused one.
            onPointerDownCapture={(e) => {
              if (!(e.target instanceof Element && e.target.closest("[data-pane-close]"))) onFocus(p.id);
            }}
            onFocusCapture={() => onFocus(p.id)}
          >
            {contents[p.id]}
            {/* Top-right of the pane, over its header row (chats leave room for it). Terminals, diffs and UIs carry their own. */}
            {many && p.content?.kind !== "terminal" && p.content?.kind !== "diff" && p.content?.kind !== "ui" && (
              <Hint label="Close this pane" shortcut="closePane">
                <Button
                  data-pane-close
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Close this pane"
                  className="absolute top-2 right-2 z-30 text-muted-foreground opacity-60 group-focus-within/pane:opacity-100 group-hover/pane:opacity-100 focus-visible:opacity-100"
                  onClick={() => onClose(p.id)}
                >
                  <X />
                </Button>
              </Hint>
            )}
            {/* Which pane the keyboard and the sidebar act on, once there are several. */}
            {many && focused && <div aria-hidden className="pointer-events-none absolute inset-0 z-20 ring-2 ring-ring/45 ring-inset" />}
          </section>
        );
      })}
      {splitRects(root).map(({ split, rect }) => (
        <Divider
          key={split.id}
          split={split}
          rect={rect}
          px={(split.dir === "row" ? rect.w * size.w : rect.h * size.h) || 0}
          grid={grid}
          onDrag={(ratio) => setDrag({ id: split.id, ratio })}
          onDone={(ratio) => {
            setDrag(null);
            onResize(split.id, ratio);
          }}
        />
      ))}
    </div>
  );
}

function Divider({
  split,
  rect,
  px,
  grid,
  onDrag,
  onDone,
}: {
  split: Split;
  /** The box the split divides. */
  rect: Rect;
  /** That box's length along the split, in pixels (0 before it's measured). */
  px: number;
  grid: React.RefObject<HTMLDivElement | null>;
  onDrag: (ratio: number) => void;
  onDone: (ratio: number) => void;
}) {
  const row = split.dir === "row";
  const [dragging, setDragging] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const clamp = (r: number) => clampRatio(split, r, px, interfaceScale());

  const start = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const area = grid.current?.getBoundingClientRect();
    if (!area || px <= 0) return;
    const origin = row ? area.left + rect.x * area.width : area.top + rect.y * area.height;
    let ratio = split.ratio;
    const move = (ev: globalThis.PointerEvent) => {
      ratio = clamp(((row ? ev.clientX : ev.clientY) - origin) / px);
      onDrag(ratio);
    };
    const up = () => {
      stop.current?.();
      onDone(ratio);
    };
    stop.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      stop.current = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    setDragging(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    const keys: Record<string, number> = row
      ? { ArrowLeft: split.ratio - step, ArrowRight: split.ratio + step, Home: 0, End: 1 }
      : { ArrowUp: split.ratio - step, ArrowDown: split.ratio + step, Home: 0, End: 1 };
    if (!(e.key in keys) || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    onDone(clamp(keys[e.key]));
  };

  const at = row ? rect.x + rect.w * split.ratio : rect.y + rect.h * split.ratio;
  const style: CSSProperties = row
    ? { left: `${at * 100}%`, top: `${rect.y * 100}%`, height: `${rect.h * 100}%` }
    : { top: `${at * 100}%`, left: `${rect.x * 100}%`, width: `${rect.w * 100}%` };
  return (
    <>
      <div
        role="separator"
        aria-orientation={row ? "vertical" : "horizontal"}
        aria-label={row ? "Resize the panes side by side" : "Resize the panes above and below"}
        aria-valuenow={Math.round(split.ratio * 100)}
        aria-valuemin={Math.round(clamp(0) * 100)}
        aria-valuemax={Math.round(clamp(1) * 100)}
        tabIndex={0}
        data-dragging={dragging || undefined}
        title="Drag to resize · double-click to make them equal"
        className={cn(
          "group absolute z-30 flex touch-none items-center justify-center outline-none",
          row ? "w-[7px] -translate-x-1/2 cursor-col-resize" : "h-[7px] -translate-y-1/2 cursor-row-resize",
        )}
        style={style}
        onPointerDown={start}
        onKeyDown={onKeyDown}
        onDoubleClick={() => onDone(clamp(0.5))}
      >
        <div
          className={cn(
            "bg-border transition-colors group-hover:bg-ring group-focus-visible:bg-ring group-data-dragging:bg-ring",
            row ? "h-full w-px group-hover:w-0.5 group-data-dragging:w-0.5" : "h-px w-full group-hover:h-0.5 group-data-dragging:h-0.5",
          )}
        />
      </div>
      {/* While dragging, nothing underneath (a previewed page's frame) takes the pointer. */}
      {dragging && <div className={cn("fixed inset-0 z-50", row ? "cursor-col-resize" : "cursor-row-resize")} />}
    </>
  );
}
