// How references to tracker items look: a row in the composer's `#` list, a
// chip in a sent message (a link to the item, or marked when it couldn't be
// read), and the composer's row of what the message will attach. Rust reads and
// ranks them (references.rs); these only draw.
import { Fragment } from "react";
import { AlertTriangle, CircleDot, GitMerge, GitPullRequest, Loader2, SquareKanban } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Reference } from "@/lib/api";
import { openExternal } from "@/lib/links";
import { KIND_LABEL, referenceLabel, segments, SERVICE_LABEL, stateText } from "@/lib/references";
import { cn } from "@/lib/utils";

/** The service's mark, with the kind: a PR or MR gets the merge icon of its service. */
export function ReferenceIcon({ reference, className }: { reference: Pick<Reference, "service" | "kind">; className?: string }) {
  const Icon =
    reference.service === "linear" ? SquareKanban : reference.kind === "pr" ? GitPullRequest : reference.kind === "mr" ? GitMerge : CircleDot;
  return <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden />;
}

/** open / draft / merged / closed / done / canceled, in stock badge variants. */
export function StateBadge({ reference }: { reference: Pick<Reference, "state" | "status"> }) {
  const text = stateText(reference);
  if (!text) return null;
  const quiet = ["closed", "canceled", "draft"].includes(reference.state);
  return (
    <Badge
      variant={reference.state === "merged" || reference.state === "done" ? "secondary" : "outline"}
      className={cn("h-4 shrink-0 px-1.5 text-2xs font-normal", quiet && "text-muted-foreground")}
    >
      {text}
    </Badge>
  );
}

/** A row of the composer's `#` list: service and kind, id, title, state, and where it lives. */
export function ReferenceRow({ reference }: { reference: Reference }) {
  return (
    <>
      <ReferenceIcon reference={reference} />
      <span className="sr-only">
        {SERVICE_LABEL[reference.service]} {KIND_LABEL[reference.kind]}
      </span>
      <span className="shrink-0 font-mono text-xs">{reference.id}</span>
      <span className="min-w-0 truncate">{reference.title}</span>
      <StateBadge reference={reference} />
      <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground" aria-hidden>
        {KIND_LABEL[reference.kind]} · {reference.scope}
      </span>
    </>
  );
}

/** A sent reference inside the message: a link to the item, or marked when it couldn't be read. */
export function ReferenceChip({ reference }: { reference: Reference }) {
  const failed = reference.error != null;
  const tip = failed
    ? `Couldn't read ${reference.token}: ${reference.error}`
    : [reference.title, stateText(reference), reference.url].filter(Boolean).join("\n");
  const body = (
    <>
      {failed ? <AlertTriangle className="size-3 shrink-0" aria-hidden /> : <ReferenceIcon reference={reference} className="size-3" />}
      <span className="font-mono text-[0.92em]">{reference.id}</span>
    </>
  );
  const chip = cn(
    "mx-px inline-flex items-baseline gap-1 rounded-sm px-1 align-baseline [&>svg]:self-center",
    failed ? "bg-destructive/10 text-destructive" : "bg-background/70 text-foreground ring-1 ring-foreground/10",
  );
  if (failed || !reference.url)
    return (
      <span className={chip} title={tip} aria-label={referenceLabel(reference)}>
        {body}
      </span>
    );
  return (
    <a
      href={reference.url}
      className={cn(chip, "underline-offset-2 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none")}
      title={tip}
      aria-label={referenceLabel(reference)}
      onClick={(e) => {
        e.preventDefault();
        openExternal(reference.url);
      }}
    >
      {body}
    </a>
  );
}

/** A message's text with the references Rust read drawn as chips (the text itself unchanged). */
export function ReferenceText({ text, references }: { text: string; references?: Reference[] }) {
  // Plain text stays a bare text node, as the bubble had it.
  if (!references?.length) return text;
  return (
    <>
      {segments(text, references).map((s, i) =>
        "reference" in s ? <ReferenceChip key={i} reference={s.reference} /> : <Fragment key={i}>{s.text}</Fragment>,
      )}
    </>
  );
}

/** Under a sent message: the references that couldn't be read, and why (the message went without their details). */
export function ReferenceNotes({ references }: { references?: Reference[] }) {
  const failed = (references ?? []).filter((r) => r.error != null);
  if (!failed.length) return null;
  return (
    <ul className="flex flex-col items-end gap-0.5 text-xs text-destructive" aria-label="References that couldn't be read">
      {failed.map((r) => (
        <li key={r.token} className="max-w-full [overflow-wrap:anywhere]">
          Couldn't read <span className="font-mono">{r.token}</span>: {r.error}. Sent without its details.
        </li>
      ))}
    </ul>
  );
}

/**
 * In the composer's frame, beside the attachments and shaped like them: the references picked so
 * far that the message will attach, each "Reading…" while Rust reads them on send.
 */
export function ReferenceChips({ references, sending }: { references: Reference[]; sending: boolean }) {
  if (!references.length) return null;
  return (
    <ul className="flex max-w-full min-w-0 flex-wrap gap-1.5" aria-label="References this message attaches" aria-busy={sending || undefined}>
      {references.map((r) => (
        <li
          key={r.token}
          className="flex max-w-[min(16rem,100%)] items-center gap-2 rounded-lg border bg-card px-2 py-1 text-xs"
          title={`Attaches ${r.token}\n${r.title}`}
        >
          {sending ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
          ) : (
            <ReferenceIcon reference={r} className="size-4 text-muted-foreground" />
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono font-medium">{r.id}</span>
            <span className="truncate text-muted-foreground">{sending ? "Reading…" : r.title}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
