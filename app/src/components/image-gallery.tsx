// A set of images (a folded tool group's screenshots, one card's several images) as a mosaic in
// a dialog; a click on a tile opens that one image large, with Prev/Next. Esc steps back: from
// the single image to the mosaic, from the mosaic closes. Images come through `useImageUrl`, the
// same loader every thumbnail uses.
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Grid2x2, ImageOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { imageFacts, useImageUrl } from "@/hooks/use-image-url";
import type { ImageBlock } from "@/lib/attachments";

export type GalleryItem = { image: ImageBlock; /** The tool call (or message) the image came from. */ title: string };

/** Tiles past this many only fetch their bytes once they near the screen. */
const EAGER_TILES = 24;

export function ImageGallery({
  open,
  onOpenChange,
  sessionId,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | undefined;
  items: GalleryItem[];
}) {
  // `null`: the mosaic. Always starts there.
  const [index, setIndex] = useState<number | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setIndex(null);
  }
  // Back in the mosaic, focus goes to the tile the keyboard just left.
  const last = useRef<number | null>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (index === null && last.current !== null) {
      body.current?.querySelector<HTMLElement>(`[data-tile="${last.current}"]`)?.focus({ preventScroll: false });
      last.current = null;
    }
    if (index !== null) last.current = index;
  }, [index]);

  const total = items.length;
  const go = (to: number) => setIndex(Math.min(total - 1, Math.max(0, to)));
  const current = index === null ? null : items[index];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="image-gallery"
        className="flex h-[92vh] w-[96vw] max-w-none flex-col gap-0 bg-background p-0 sm:max-w-none"
        onEscapeKeyDown={(e) => {
          if (index === null) return;
          e.preventDefault();
          setIndex(null);
        }}
        onKeyDown={(e) => {
          if (index === null || e.altKey || e.ctrlKey || e.metaKey) return;
          if (e.key === "ArrowRight") go(index + 1);
          else if (e.key === "ArrowLeft") go(index - 1);
          else return;
          e.preventDefault();
        }}
      >
        <div className="flex items-center gap-3 border-b px-4 py-2.5 pr-12">
          {current && index !== null ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setIndex(null)}>
                <Grid2x2 /> Back to all
              </Button>
              <DialogTitle className="min-w-0 truncate text-sm">{current.title}</DialogTitle>
              <DialogDescription className="shrink-0 text-xs text-muted-foreground">{imageFacts(current.image)}</DialogDescription>
              <div className="ml-auto flex items-center gap-1">
                <Button size="icon-sm" variant="ghost" disabled={index === 0} onClick={() => go(index - 1)}>
                  <ChevronLeft />
                  <span className="sr-only">Previous image</span>
                </Button>
                <span aria-live="polite" className="min-w-14 text-center text-xs text-muted-foreground tabular-nums">
                  {index + 1} of {total}
                </span>
                <Button size="icon-sm" variant="ghost" disabled={index === total - 1} onClick={() => go(index + 1)}>
                  <ChevronRight />
                  <span className="sr-only">Next image</span>
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogTitle className="text-sm">All images</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">{total} images</DialogDescription>
            </>
          )}
        </div>
        <div ref={body} className="min-h-0 flex-1 overflow-auto bg-muted/30 p-4">
          {current && index !== null ? (
            <Single key={index} sessionId={sessionId} item={current} />
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }} data-slot="image-mosaic">
              {items.map((item, i) => (
                <Tile key={item.image.image ?? i} sessionId={sessionId} item={item} i={i} total={total} onOpen={() => setIndex(i)} />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Single({ sessionId, item }: { sessionId: string | undefined; item: GalleryItem }) {
  const { url, failed } = useImageUrl(sessionId, item.image);
  if (item.image.omitted) return <p className="py-16 text-center text-sm text-muted-foreground">{item.image.omitted}</p>;
  return url ? (
    <img src={url} alt={item.title} className="mx-auto block max-h-full max-w-full object-contain" />
  ) : (
    <p className="py-16 text-center text-sm text-muted-foreground">{failed ? "This image is no longer kept." : "Loading…"}</p>
  );
}

function Tile({
  sessionId,
  item,
  i,
  total,
  onOpen,
}: {
  sessionId: string | undefined;
  item: GalleryItem;
  i: number;
  total: number;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [near, setNear] = useState(i < EAGER_TILES);
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  const { url, failed } = useImageUrl(sessionId, near ? item.image : {});
  const omitted = item.image.omitted;
  return (
    <button
      ref={ref}
      type="button"
      data-tile={i}
      onClick={onOpen}
      aria-label={`Open image ${i + 1} of ${total}, ${item.title}`}
      className="flex flex-col gap-1 rounded-md border bg-card p-1.5 text-left [contain-intrinsic-size:auto_200px] [content-visibility:auto] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-sm bg-muted/50 text-muted-foreground" aria-hidden>
        {url ? (
          <img src={url} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-contain" />
        ) : omitted || failed ? (
          <ImageOff className="size-4" />
        ) : null}
      </span>
      <span className="truncate text-xs">{item.title}</span>
      <span className="text-[11px] text-muted-foreground tabular-nums">
        {i + 1} of {total}
      </span>
    </button>
  );
}
