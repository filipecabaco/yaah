// The one tooltip for charts, maps and graphs: text only, placed beside its anchor inside `box`
// (placeTip, chart-layout.ts) after measuring itself, so it never spills out of the card. The same
// content shows on hover and on keyboard focus; the mark's own aria-label carries it too.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { placeTip, type Box } from "@/components/ui-blocks/chart-layout";
import { cn } from "@/lib/utils";

export function VizTooltip({
  id,
  anchor,
  box,
  children,
  className,
}: {
  id: string;
  anchor: { x: number; y: number };
  box: Box;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Box>({ w: 180, h: 84 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = { w: el.offsetWidth, h: el.offsetHeight };
    if (next.w > 0 && next.h > 0 && (next.w !== size.w || next.h !== size.h)) setSize(next);
    // Measured again when what it shows changes; the guard stops a loop.
  }, [anchor.x, anchor.y, children, size.w, size.h]);
  const pos = placeTip(anchor, size, box);
  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      data-place={`${pos.x} ${pos.y}`}
      className={cn(
        "pointer-events-none absolute z-10 grid min-w-36 gap-1 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md",
        className,
      )}
      style={{ left: pos.left, top: pos.top }}
    >
      {children}
    </div>
  );
}
