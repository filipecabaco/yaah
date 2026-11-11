// Resizable table columns, shared by Markdown tables (components/markdown.tsx) and the `table`
// primitive (ui-blocks/data-table.tsx). A table lays itself out to its content until the user
// grabs a column edge; then every column's width is fixed at what it was and the one they drag
// follows the pointer (the table grows past its box and scrolls sideways, as in a spreadsheet).
// Double-click an edge to go back to the automatic layout; Left/Right arrows move a focused edge.
import { useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

/** The narrowest a column can be dragged to. */
const MIN = 48;
const STEP = 16;
const BIG_STEP = 64;

export type ColumnResize = ReturnType<typeof useColumnResize>;

export function useColumnResize() {
  /** One width per column (px) once the user resized any; `null` is the automatic layout. */
  const [widths, setWidths] = useState<number[] | null>(null);

  /** The widths now: what the user set, else what the browser laid out in this header row. */
  const current = (th: HTMLElement): number[] => widths ?? Array.from(th.parentElement?.children ?? [], (c) => c.getBoundingClientRect().width);

  const set = (th: HTMLElement, index: number, width: number) => {
    const next = [...current(th)];
    next[index] = Math.max(MIN, Math.round(width));
    setWidths(next);
  };

  return {
    widths,
    /** `table-layout: fixed` at the sum of the widths, once resized. */
    tableStyle: (widths ? { tableLayout: "fixed", width: widths.reduce((a, b) => a + b, 0) } : undefined) as CSSProperties | undefined,
    /** The width of column `index`, when the user set one. */
    widthOf: (index: number) => widths?.[index],
    reset: () => setWidths(null),
    /** A drag on the edge of the header cell `th` (column `index`). */
    start(e: PointerEvent, th: HTMLElement, index: number) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const base = current(th);
      const x0 = e.clientX;
      const w0 = base[index];
      setWidths(base);
      const move = (ev: globalThis.PointerEvent) =>
        setWidths(base.map((w, i) => (i === index ? Math.max(MIN, Math.round(w0 + ev.clientX - x0)) : w)));
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    key(e: KeyboardEvent, th: HTMLElement, index: number) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      e.stopPropagation();
      const step = (e.shiftKey ? BIG_STEP : STEP) * (e.key === "ArrowLeft" ? -1 : 1);
      set(th, index, current(th)[index] + step);
    },
  };
}
