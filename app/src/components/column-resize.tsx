// The grab area on a table header cell's right edge (hooks/use-column-resize.ts holds the behaviour).
import type { ColumnResize } from "@/hooks/use-column-resize";

/** The cell must be `relative`. */
export function ResizeHandle({ resize, index, label }: { resize: ColumnResize; index: number; label: string }) {
  const th = (el: HTMLElement) => el.closest("th") as HTMLElement;
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      title="Drag to resize · double-click to reset"
      tabIndex={0}
      data-col-resize
      onPointerDown={(e) => resize.start(e, th(e.currentTarget), index)}
      onKeyDown={(e) => resize.key(e, th(e.currentTarget), index)}
      onDoubleClick={resize.reset}
      className="group/resize absolute top-0 right-0 z-10 flex h-full w-2.5 cursor-col-resize touch-none items-center justify-end outline-none"
    >
      <span className="h-1/2 w-px rounded-full bg-border transition-[width,height,background-color] group-hover/resize:h-3/4 group-hover/resize:w-0.5 group-hover/resize:bg-ring group-focus-visible/resize:h-3/4 group-focus-visible/resize:w-0.5 group-focus-visible/resize:bg-ring" />
    </span>
  );
}
