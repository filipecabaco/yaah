// The yaah mark: four rounded UI tiles locking together into a "y" (and, read
// again, an app layout: a sidebar, a panel, a bar). The middle tile is the
// agent's piece, in the one brand colour; the rest follow the text colour, so
// the mark sits in any theme. `assemble` plays the tiles clicking into place.
import { cn } from "@/lib/utils";

/** [x, y, width, height] in a 50×60 box: top-left arm, right stem, middle bar, foot. */
const TILES = [
  [0, 0, 16, 22],
  [34, 0, 16, 60],
  [0, 25, 31, 16],
  [8, 44, 23, 16],
] as const;

/**
 * `assemble`: the tiles click into place once. `loading`: they slide together, hold and slide
 * on, in a loop (the start-up indicator; its CSS is in index.html so it runs before any script).
 */
export function Mark({
  className,
  assemble = false,
  loading = false,
  title,
}: {
  className?: string;
  assemble?: boolean;
  loading?: boolean;
  title?: string;
}) {
  return (
    <svg
      viewBox="-10 -5 70 70"
      className={cn("yaah-mark shrink-0", className)}
      data-assemble={(assemble && !loading) || undefined}
      data-loading={loading || undefined}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {TILES.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx={5} data-tile={i} className={i === 2 ? "fill-brand" : "fill-current"} />
      ))}
    </svg>
  );
}

/** The mark with the name beside it, as in the sidebar. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <Mark className="size-[1.35em]" />
      <span className="font-semibold tracking-tight">yaah</span>
    </span>
  );
}
