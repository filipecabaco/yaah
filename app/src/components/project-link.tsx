// A project started from a tracker item: the pill by its name, and the item
// shown live (the yaah pack's component for it), with refresh and unlink.
// Rust re-fetches the item and rewrites the brief's block; this only shows it.
import { useEffect, useState } from "react";
import { ChevronRight, ExternalLink, Loader2, RefreshCw, Unlink } from "lucide-react";
import { ErrorText } from "@/components/error-text";
import { UiTree } from "@/components/ui-render";
import { ServiceIcon } from "@/components/work-items";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { api, type Project, type ProjectLink } from "@/lib/api";
import { formatAgo } from "@/lib/format";
import { openExternal } from "@/lib/links";
import { liveComponentFor, SERVICES } from "@/lib/work-items";
import { cn } from "@/lib/utils";

/** What the pill says after the service: the id, or a Linear project's name (its id is a slug). */
const shortName = (link: ProjectLink) => (link.service === "linear-project" ? link.title : link.id);
/** "issue", or "project" for a Linear project. */
const noun = (link: ProjectLink) => (link.service === "linear-project" ? "project" : "issue");

/** "Linear · ENG-142": opens the item in the browser. */
export function ProjectLinkPill({ link }: { link: ProjectLink }) {
  const label = `${SERVICES[link.service].label} · ${shortName(link)}`;
  return (
    <Button
      variant="outline"
      size="xs"
      className="max-w-full min-w-0 rounded-full font-normal text-muted-foreground"
      onClick={() => openExternal(link.url)}
      title={`${link.title}\n${link.url}`}
      aria-label={`Open ${label} in the browser`}
    >
      <ServiceIcon service={link.service} />
      <span className="truncate">{label}</span>
      <ExternalLink className="opacity-60" />
    </Button>
  );
}

type Props = {
  project: Project & { link: ProjectLink };
  onChange: (p: Project) => void;
  /** Runs before Rust rewrites the brief (saves unsaved edits first). */
  beforeBriefChange: () => Promise<void>;
  /** The brief was rewritten: read it again. */
  onBriefChanged: () => void;
};

/** The linked item, live, with "Refresh from issue" and "Unlink". */
export function ProjectLinkSection({ project, onChange, beforeBriefChange, onBriefChanged }: Props) {
  const { link } = project;
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState<"refresh" | "unlink" | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // "synced 5 min ago" keeps up while the page stays open.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const change = async (what: "refresh" | "unlink", f: () => Promise<Project>) => {
    setBusy(what);
    setError(null);
    try {
      await beforeBriefChange();
      onChange(await f());
      onBriefChanged();
      setConfirmUnlink(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label={`Linked ${noun(link)}`} className="flex flex-col gap-2">
      <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <CollapsibleTrigger className="-ml-1 flex items-center gap-1 rounded-md px-1 text-sm font-medium hover:bg-muted">
            <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
            {link.service === "linear-project" ? "Linear project" : "Issue"}
          </CollapsibleTrigger>
          <span className="text-xs text-muted-foreground" title={new Date(link.syncedAt * 1000).toLocaleString()}>
            synced {formatAgo(link.syncedAt)}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost"
              disabled={!!busy}
              onClick={() => void change("refresh", () => api.refreshProjectLink(project.id))}
              title="Fetch it again and rewrite its block in the brief. The status and name stay as they are."
            >
              <RefreshCw className={cn(busy === "refresh" && "animate-spin")} /> Refresh from {noun(link)}
            </Button>
            <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={!!busy} onClick={() => setConfirmUnlink(true)}>
              <Unlink /> Unlink
            </Button>
          </div>
        </div>

        {confirmUnlink && (
          <div role="group" aria-label="Unlink" className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
            <span className="min-w-0 flex-1 text-sm">
              Unlink {shortName(link)}? Its block leaves the brief; the project, its chats and repos stay.
            </span>
            <Button variant="destructive" size="sm" disabled={!!busy} onClick={() => void change("unlink", () => api.unlinkProject(project.id))}>
              {busy === "unlink" && <Loader2 className="animate-spin" />}
              Unlink
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmUnlink(false)}>
              Keep
            </Button>
          </div>
        )}
        <ErrorText error={error} className="text-sm whitespace-pre-wrap" />

        <CollapsibleContent>
          {/* A refresh re-reads it at once rather than at the next interval. */}
          <LiveItem key={link.syncedAt} link={link} />
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/** The item through the yaah pack component for it, as the Component library previews one. */
function LiveItem({ link }: { link: ProjectLink }) {
  const target = liveComponentFor(link);
  const [prepared, setPrepared] = useState<{ tree: unknown; props: Record<string, unknown> } | null>(null);
  const [error, setError] = useState<unknown>(target ? null : `can't tell the issue from “${link.id}”`);
  const name = target?.name;
  const props = JSON.stringify(target?.props);
  useEffect(() => {
    if (!name) return;
    let live = true;
    api.previewComponent(name, JSON.parse(props) as Record<string, unknown>).then(
      (p) => live && setPrepared(p),
      (e: unknown) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [name, props]);

  if (error != null) return <ErrorText error={error} prefix="Can't show it live: " className="text-sm" />;
  if (!prepared)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" /> Loading {link.id}…
      </p>
    );
  return <UiTree tree={prepared.tree} props={prepared.props} />;
}
