// Attachments in a chat's composer: dropping on the pane (with an overlay saying what will
// happen), pasting, the Attach button, the chips above the textarea, and the attachments of a
// sent message in the transcript. Rust reads and checks every file (attachments.rs); this only
// asks it to and draws the answer.
import { File as FileIcon, FileText, Folder, Loader2, Paperclip, X } from "lucide-react";
import { Hint } from "@/components/shortcuts";
import { ImageThumb } from "@/components/image-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ComposerAttachments, PaneDrag } from "@/hooks/use-attachments";
import type { AgentReport } from "@/lib/api";
import { capabilityText, countText, dropHeadline, sentText, type Attachment } from "@/lib/attachments";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The overlay over a pane while something is dragged over it: what will happen, and what this agent takes. */
export function DropOverlay({ drag, agent, report }: { drag: PaneDrag | null; agent: string; report?: AgentReport | null }) {
  if (!drag) return null;
  let headline: string;
  let detail: string;
  if ("text" in drag) {
    headline = "Drop to add the text to your message";
    detail = "It goes in at the cursor";
  } else if ("browserFiles" in drag) {
    headline = `Drop to attach ${drag.browserFiles === 1 ? "it" : "them"} to this message`;
    detail = capabilityText(agent, report, [{ name: "", kind: "image" }]);
  } else {
    headline = dropHeadline(drag.items);
    detail = capabilityText(agent, report, drag.items);
  }
  return (
    <div
      data-slot="drop-overlay"
      className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-ring bg-background/90 p-6 text-center backdrop-blur-sm"
    >
      <Paperclip className="size-6 text-muted-foreground" aria-hidden />
      <p role="status" aria-live="polite" className="text-sm font-medium">
        {headline}
      </p>
      <p className="max-w-[48ch] text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

/** The paperclip: the OS file picker, for keyboard users and anyone who'd rather not drag. */
export function AttachButton({ onPick, disabled }: { onPick: () => Promise<void>; disabled?: boolean }) {
  return (
    <Hint label="Attach files">
      <Button
        size="icon"
        variant="ghost"
        disabled={disabled}
        aria-label="Attach files"
        onClick={() => void onPick().catch((e: unknown) => console.error("could not open the file picker", e))}
      >
        <Paperclip />
      </Button>
    </Hint>
  );
}

function kindIcon(a: Pick<Attachment, "kind" | "text">) {
  if (a.kind === "folder") return <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />;
  return a.text ? (
    <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
  ) : (
    <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
  );
}

/** "image, 1.2 MB" for the chip's label. */
function describeItem(a: Attachment): string {
  const kind = a.kind === "image" ? "image" : a.kind === "folder" ? "folder" : "file";
  return [kind, a.size != null ? formatBytes(a.size) : null, a.note].filter(Boolean).join(", ");
}

/** The chips above the textarea: what's attached, each removable; refusals and progress below. */
export function AttachmentChips({ sessionId, state, className }: { sessionId: string; state: ComposerAttachments; className?: string }) {
  const { items, refused, pending, announce } = state;
  const summary = items.length ? `${countText(items)} attached` : "";
  return (
    <div className={cn("flex flex-col gap-1.5", !items.length && !refused.length && !pending && "contents", className)}>
      <p className="sr-only" aria-live="polite">
        {[announce, summary].filter(Boolean).join(". ")}
      </p>
      {items.length > 0 && (
        <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
          {items.map((a) => (
            <li
              key={a.id}
              className="flex max-w-64 items-center gap-2 rounded-lg border bg-card py-1 pr-1 pl-1.5 text-xs"
              title={[a.path && !a.pasted ? a.path : a.name, a.note].filter(Boolean).join("\n")}
            >
              {a.kind === "image" && a.image ? (
                <ImageThumb
                  sessionId={sessionId}
                  image={{ type: "image", image: a.image, mimeType: a.mimeType, size: a.size, width: a.width, height: a.height }}
                  alt={a.name}
                  path={a.pasted ? null : a.path}
                  note={a.note}
                  variant="chip"
                />
              ) : (
                kindIcon(a)
              )}
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{a.name}</span>
                <span className="truncate text-muted-foreground">{describeItem(a)}</span>
              </span>
              <Button size="icon-xs" variant="ghost" aria-label={`Remove ${a.name}`} onClick={() => state.remove(a.id)}>
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {pending && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden /> Attaching…
        </p>
      )}
      {refused.length > 0 && (
        <div role="alert" className="flex items-start gap-2 text-xs text-destructive">
          <ul className="min-w-0 flex-1">
            {refused.map((r, i) => (
              <li key={i}>
                <span className="font-medium">{r.name}</span> {r.reason}
              </li>
            ))}
          </ul>
          <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={state.dismissRefused}>
            <X />
          </Button>
        </div>
      )}
    </div>
  );
}

/** What the user attached to a sent message: images as thumbnails, the rest as chips saying how they went. */
export function SentAttachments({ sessionId, files }: { sessionId: string | undefined; files: Attachment[] }) {
  if (!files.length) return null;
  const images = files.filter((f) => f.kind === "image" && f.image);
  const others = files.filter((f) => !(f.kind === "image" && f.image));
  return (
    <div className="flex max-w-full flex-col items-end gap-1" aria-label={`${countText(files)} attached`}>
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((f) => (
            <ImageThumb
              key={f.id}
              sessionId={sessionId}
              image={{ type: "image", image: f.image, mimeType: f.mimeType, size: f.size, width: f.width, height: f.height }}
              alt={f.name}
              path={f.pasted ? null : f.path}
              note={[sentText(f), f.note].filter(Boolean).join(" · ")}
              variant="strip"
            />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1">
          {others.map((f) => (
            <Badge
              key={f.id}
              variant="outline"
              className="max-w-64 gap-1 text-muted-foreground"
              title={[f.path, sentText(f)].filter(Boolean).join("\n")}
            >
              {kindIcon(f)}
              <span className="truncate">{f.name}</span>
              {f.size != null && <span className="shrink-0 tabular-nums">{formatBytes(f.size)}</span>}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
