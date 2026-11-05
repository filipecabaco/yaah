// One way to show an image anywhere in a chat: a thumbnail that opens a large view on a click
// or Enter. Used by the composer's attachment chips, the user's sent attachments, agents'
// images in tool calls and messages, and a folded tool group's preview strip. The bytes come
// from Rust (the chat's image store) as a `blob:` URL; nothing here reads a file.
import { useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, ImageOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ImageGallery } from "@/components/image-gallery";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { imageFacts, useImageUrl } from "@/hooks/use-image-url";
import { pathOfUri, type ImageBlock } from "@/lib/attachments";
import { isMac } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

type ThumbProps = {
  sessionId: string | undefined;
  image: ImageBlock;
  /** What the image is: a file name, or the tool call that made it. Used as alt text and the large view's title. */
  alt: string;
  /** A file of the user's or the agent's, offered as "Reveal in Finder" in the large view. */
  path?: string | null;
  note?: string;
  className?: string;
  /** `inline`: as big as the column lets it (agents' images); `chip`: a small square (attachments). */
  variant?: "inline" | "chip" | "strip";
  /** Replaces the large view: the thumbnail is one of a set that opens as a mosaic. */
  onOpen?: () => void;
};

/** A thumbnail that opens the large view. */
export function ImageThumb({ sessionId, image, alt, path, note, className, variant = "inline", onOpen }: ThumbProps) {
  const [open, setOpen] = useState(false);
  const { url, failed } = useImageUrl(sessionId, image);
  if (image.omitted)
    return (
      <p className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
        <ImageOff className="size-3.5" aria-hidden /> {image.omitted}
      </p>
    );
  const facts = imageFacts(image);
  const size = {
    inline: "max-h-80 max-w-full rounded-md border bg-muted/30",
    strip: "h-16 max-w-40 rounded-md border bg-muted/30 object-cover",
    chip: "size-10 rounded-sm object-cover",
  }[variant];
  return (
    <>
      <button
        type="button"
        onClick={onOpen ?? (() => setOpen(true))}
        aria-label={`Open ${alt}${facts ? `, ${facts}` : ""}`}
        title={alt}
        data-slot="image-thumb"
        className={cn(
          "w-fit shrink-0 rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
          variant === "inline" && "max-w-full",
          className,
        )}
      >
        {url ? (
          <img src={url} alt={alt} className={cn("block", size)} draggable={false} />
        ) : (
          <span className={cn("flex items-center justify-center text-muted-foreground", size, variant === "inline" && "h-24 w-40")} aria-hidden>
            {failed ? <ImageOff className="size-4" /> : null}
          </span>
        )}
      </button>
      <ImageLightbox open={open && !onOpen} onOpenChange={setOpen} url={url} alt={alt} facts={facts} path={path} note={note} failed={failed} />
    </>
  );
}

const REVEAL_LABEL = isMac ? "Reveal in Finder" : "Show in file manager";

/** The large view: the image as big as the window allows, what it is, and where it came from when that's a file. */
export function ImageLightbox({
  open,
  onOpenChange,
  url,
  alt,
  facts,
  path,
  note,
  failed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string | null;
  alt: string;
  facts: string;
  path?: string | null;
  note?: string;
  failed?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[96vw] max-w-none flex-col gap-0 bg-background p-0 sm:max-w-none">
        <div className="flex items-center gap-3 border-b px-4 py-2.5 pr-12">
          <DialogTitle className="min-w-0 truncate text-sm">{alt}</DialogTitle>
          <DialogDescription className="shrink-0 text-xs text-muted-foreground">{[facts, note].filter(Boolean).join(" · ")}</DialogDescription>
          {path && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => void revealItemInDir(path).catch((e: unknown) => console.error("could not reveal", path, e))}
            >
              <FolderOpen /> {REVEAL_LABEL}
            </Button>
          )}
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/30 p-4">
          {url ? (
            <img src={url} alt={alt} className="max-h-[80vh] max-w-full object-contain" />
          ) : (
            <p className="py-16 text-sm text-muted-foreground">{failed ? "This image is no longer kept." : "Loading…"}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Several images in a row, as one strip: an agent's screenshots, a message's images. */
export function ImageStrip({
  sessionId,
  images,
  alt,
  variant = "inline",
  className,
}: {
  sessionId: string | undefined;
  images: ImageBlock[];
  alt: string;
  variant?: ThumbProps["variant"];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!images.length) return null;
  const many = images.length > 1;
  return (
    <div className={cn("flex flex-wrap items-start gap-2", className)}>
      {images.map((img, i) => (
        <ImageThumb
          key={img.image ?? i}
          sessionId={sessionId}
          image={img}
          alt={many ? `${alt} (${i + 1} of ${images.length})` : alt}
          path={pathOfUri(img.uri)}
          variant={variant}
          onOpen={many ? () => setOpen(true) : undefined}
        />
      ))}
      {many && <ImageGallery open={open} onOpenChange={setOpen} sessionId={sessionId} items={images.map((image) => ({ image, title: alt }))} />}
    </div>
  );
}
