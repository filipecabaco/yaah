// Diff lines as every diff view draws them: tabs 4 wide, no wrapping by default
// (each file scrolls sideways, its line numbers stay put), and a wrap toggle
// that wraps long lines with a hanging indent, so a wrapped line continues
// under its own code instead of back at the margin. The long review lists only
// the rows on screen (windowed), so a 5000-line file opens as fast as a small one.
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { WrapText } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DiffFile, Hunk, Line } from "@/components/diff/model";
import { OVERSCAN, rowHeight, splitIndent, tabStyle, WRAP_MAX, type Row } from "@/components/diff/lines";
import { useCodeScale } from "@/lib/fonts";
import { menuActions, type MenuAction } from "@/lib/menu-actions";
import { cn } from "@/lib/utils";

const TONE: Record<Line["kind"], string | undefined> = {
  "+": "bg-green-500/10 text-green-900 dark:text-green-200",
  "-": "bg-red-500/10 text-red-900 dark:text-red-200",
  " ": undefined,
};
/** The gutter's tint: over an opaque background, so text scrolled under it doesn't show through. */
const GUTTER_TONE: Record<Line["kind"], string | undefined> = {
  "+": "bg-green-500/15",
  "-": "bg-red-500/15",
  " ": undefined,
};

/** One line: line numbers (sticky when the file scrolls sideways), the +/− mark, the code. */
export function DiffLine({ line, wrap, fixed, className }: { line: Line; wrap: boolean; fixed?: boolean; className?: string }) {
  const { indent, rest, cols } = wrap ? splitIndent(line.text) : { indent: "", rest: line.text, cols: 0 };
  return (
    <div
      data-line=""
      className={cn(
        "flex leading-(--code-row)",
        wrap ? "w-full" : "w-max min-w-full",
        fixed ? "h-(--code-row)" : "min-h-(--code-row)",
        TONE[line.kind],
        className,
      )}
    >
      <span className="sticky left-0 z-[1] flex shrink-0 self-stretch bg-background select-none">
        <span className={cn("flex text-muted-foreground/60", GUTTER_TONE[line.kind])}>
          <span data-old="" className="w-12 pr-2 text-right tabular-nums">
            {line.old ?? ""}
          </span>
          <span data-new="" className="w-12 pr-2 text-right tabular-nums">
            {line.new ?? ""}
          </span>
        </span>
      </span>
      <span className="w-[2ch] shrink-0 text-center select-none" aria-hidden>
        {line.kind === " " ? "" : line.kind === "-" ? "−" : "+"}
      </span>
      {wrap ? (
        // Hanging indent: the leading whitespace keeps its width, the rest wraps in a box of its own beside it.
        <span className="flex min-w-0 flex-1 pr-2" style={tabStyle}>
          {indent && (
            <span className="shrink-0 whitespace-pre" style={{ width: `${cols}ch` }}>
              {indent}
            </span>
          )}
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere] whitespace-pre-wrap">{rest}</span>
        </span>
      ) : (
        <span className="pr-4 whitespace-pre" style={tabStyle}>
          {line.text}
        </span>
      )}
    </div>
  );
}

/** The header of hunk `index`, with optional tools on the right (kept in view while scrolling sideways). */
export function HunkHeader({ hunk, index, tools, mark, fixed }: { hunk: Hunk; index: number; tools?: ReactNode; mark?: boolean; fixed?: boolean }) {
  return (
    <div
      data-hunk-header={index}
      className={cn(
        "group flex items-center bg-blue-500/10 pr-1 text-muted-foreground",
        fixed ? "h-(--code-row)" : "min-h-(--code-row)",
        mark && "shadow-[inset_2px_0_0_var(--ring)]",
      )}
    >
      <span className="sticky left-0 min-w-0 truncate px-2">{hunk.header}</span>
      {tools && <span className="sticky right-1 ml-auto flex items-center gap-0.5">{tools}</span>}
    </div>
  );
}

/** Wrap long lines or scroll them sideways. */
export function WrapToggle({ wrap, onChange, disabled }: { wrap: boolean; onChange: (wrap: boolean) => void; disabled?: boolean }) {
  return (
    <Button
      variant={wrap ? "secondary" : "ghost"}
      size="xs"
      aria-pressed={wrap}
      disabled={disabled}
      title={disabled ? `Too long to wrap (over ${WRAP_MAX} lines)` : wrap ? "Scroll long lines sideways" : "Wrap long lines"}
      onClick={() => onChange(!wrap)}
    >
      <WrapText /> Wrap
    </Button>
  );
}

/**
 * A file's diff in a scrolling box (`scroller`). Unwrapped, only the rows on screen
 * (and a margin) are in the DOM; wrapped, every row is (rows vary in height), up to [WRAP_MAX].
 */
export function DiffRows({
  file,
  rows,
  current,
  scroller,
  wrap,
  hunkTools,
  hunkMenu,
}: {
  file: DiffFile;
  rows: Row[];
  /** The hunk n/p is on, marked down its edge. */
  current: number;
  scroller: RefObject<HTMLDivElement | null>;
  wrap: boolean;
  hunkTools?: (index: number) => ReactNode;
  hunkMenu?: (index: number) => MenuAction[] | undefined;
}) {
  const wrapped = wrap && rows.length <= WRAP_MAX;
  // Rows are `--code-row` tall, which follows the code size.
  const row = rowHeight(useCodeScale());
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });
  useEffect(() => {
    const el = scroller.current;
    if (!el || wrapped) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setView({ top: Math.max(0, el.scrollTop - (box.current?.offsetTop ?? 0)), height: el.clientHeight });
    };
    const later = () => {
      frame ||= requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", later, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    ro?.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", later);
      ro?.disconnect();
    };
  }, [scroller, file, wrapped]);
  // One ref per hunk for its right-click menu, made once per file.
  const menus = useMemo(() => file.hunks.map((_, i) => hunkMenu?.(i)).map((m) => (m?.length ? menuActions(m) : undefined)), [file, hunkMenu]);

  const draw = (r: Row, key: number) =>
    r.line ? (
      <div key={key} ref={menus[r.hunk]} className={cn(r.hunk === current && "shadow-[inset_2px_0_0_var(--ring)]")}>
        <DiffLine line={r.line} wrap={wrapped} fixed={!wrapped} />
      </div>
    ) : (
      <div key={key} ref={menus[r.hunk]}>
        <HunkHeader hunk={file.hunks[r.hunk]} index={r.hunk} tools={hunkTools?.(r.hunk)} mark={r.hunk === current} fixed={!wrapped} />
      </div>
    );

  if (wrapped)
    return (
      <div ref={box} className="relative font-mono text-code" data-rows={rows.length} data-wrapped="true">
        {rows.map(draw)}
      </div>
    );
  // Before the first layout (or without one), a screenful.
  const height = view.height || 1000;
  const first = Math.max(0, Math.floor(view.top / row) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + height) / row) + OVERSCAN);
  return (
    <div ref={box} className="relative font-mono text-code" style={{ height: rows.length * row }} data-rows={rows.length} data-wrapped="false">
      <div className="absolute top-0 left-0 w-max min-w-full" style={{ transform: `translateY(${first * row}px)` }}>
        {rows.slice(first, last).map((r, k) => draw(r, first + k))}
      </div>
    </div>
  );
}
