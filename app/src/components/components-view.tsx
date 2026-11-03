import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { ChevronLeft, ChevronRight, Copy, CopyPlus, LayoutPanelTop, Loader2, RefreshCw, Share2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { CopyMenuItem } from "@/components/menus";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorText } from "@/components/error-text";
import { ShareLibraryDialog } from "@/components/share-library-dialog";
import { UiTree } from "@/components/ui-render";
import { api, events, libraryApi, type UiComponent } from "@/lib/api";
import { cn } from "@/lib/utils";

/** The library a component comes from, as the user reads it. */
const libraryLabel = (c: UiComponent) => (c.source === "yaah" ? "yaah" : c.source === "local" ? "My components" : (c.library ?? c.source));
/** `acme/pr-card` → `pr-card`. */
const shortName = (name: string) => name.slice(name.lastIndexOf("/") + 1);

/**
 * Browse the UI libraries agents build from: yaah's, the user's own, and installed ones.
 * `initial` is a component to show (a chat's "Open in Component library").
 */
export function ComponentsView({ initial = null, onInitialSeen }: { initial?: string | null; onInitialSeen?: () => void }) {
  const [components, setComponents] = useState<UiComponent[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initial);
  const [filter, setFilter] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  /** The component whose "Copy to my collection" form is open. */
  const [copying, setCopying] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  // In a narrow window the list and the component take turns on screen (see the layout below).
  const [pane, setPane] = useState<"list" | "detail">(initial ? "detail" : "list");
  // Asked to show another component while open.
  const [shownInitial, setShownInitial] = useState(initial);
  if (initial && initial !== shownInitial) {
    setShownInitial(initial);
    setSelected(initial);
    setFilter(null);
    setPane("detail");
  }
  useEffect(() => {
    if (initial) onInitialSeen?.();
  }, [initial, onInitialSeen]);

  const load = useCallback(() => {
    api.listComponents().then((list) => {
      setError(null);
      setComponents(list);
      setSelected((s) => (s && list.some((c) => c.name === s) ? s : (list[0]?.name ?? null)));
    }, setError);
  }, []);
  useEffect(() => {
    load();
    // A library installed, updated or turned off adds or removes components.
    const off = events.librariesChanged(load);
    return () => void off.then((f) => f());
  }, [load]);

  // yaah's first, then the user's, then each installed library by title.
  const all = components ?? [];
  const sources = [...new Set(all.map((c) => c.source))].sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)));
  function label(source: string) {
    const c = all.find((x) => x.source === source);
    return c ? libraryLabel(c) : source;
  }
  const shown = filter && sources.includes(filter) ? filter : null;
  const groups = sources.filter((s) => !shown || s === shown).map((s) => [s, all.filter((c) => c.source === s)] as const);
  const current = all.find((c) => c.name === selected) ?? null;
  const local = all.filter((c) => c.source === "local");

  const open = (name: string) => {
    setSelected(name);
    setCopying(null);
    setPane("detail");
  };

  const pickFilter = (source: string | null) => {
    setFilter(source);
    if (source && current?.source !== source) setSelected(all.find((c) => c.source === source)?.name ?? null);
  };

  return (
    // Wide: the list beside the component. Narrow (under 36rem for this page, i.e. a window
    // under about 700px beside the sidebar): one at a time, the list or the component with a
    // way back to the list. A container query, so it follows the page's own width.
    <main className="@container/library flex min-w-0 flex-1" data-pane={pane}>
      <div
        className={cn(
          "flex w-64 shrink-0 flex-col border-r @max-xl/library:w-full @max-xl/library:border-r-0",
          pane === "detail" && current && "@max-xl/library:hidden",
        )}
      >
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-sm font-medium">Component library</h1>
          <Button variant="ghost" size="icon-xs" onClick={load} title="Refresh" aria-label="Refresh components">
            <RefreshCw />
          </Button>
        </div>
        {sources.length > 1 && (
          <div className="flex flex-wrap gap-1 px-3 pb-1" role="group" aria-label="Show library">
            <Chip active={!shown} onClick={() => pickFilter(null)}>
              All
            </Chip>
            {sources.map((s) => (
              <Chip key={s} active={shown === s} onClick={() => pickFilter(s)}>
                {label(s)}
              </Chip>
            ))}
          </div>
        )}
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3" aria-label="Components">
          {groups.map(([source, list]) => (
            <div key={source} className="flex flex-col gap-0.5">
              <h2 className="px-2 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {source === "yaah" ? "Provided by yaah" : label(source)}
              </h2>
              {list.map((c) => (
                <ComponentMenu
                  key={c.name}
                  component={c}
                  onOpen={() => open(c.name)}
                  onCopy={() => {
                    setSelected(c.name);
                    setCopying(c.name);
                  }}
                  onShare={() => {
                    setSelected(c.name);
                    setSharing(true);
                  }}
                >
                  <button
                    type="button"
                    aria-current={c.name === selected || undefined}
                    onClick={() => open(c.name)}
                    className={cn(
                      "flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted data-[state=open]:bg-muted",
                      c.name === selected && "bg-muted",
                    )}
                  >
                    <span className="flex w-full items-center gap-1.5 text-sm">
                      <span className="truncate font-mono text-xs">{c.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground">v{c.version}</span>
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{c.description}</span>
                  </button>
                </ComponentMenu>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t p-2">
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => setSharing(true)}>
            <Share2 /> Share as library…
          </Button>
        </div>
      </div>

      <div className={cn("min-w-0 flex-1 overflow-y-auto", (pane === "list" || !current) && "@max-xl/library:hidden")}>
        {current && (
          <div className="sticky top-0 z-10 border-b bg-background px-2 py-1.5 @xl/library:hidden">
            <Button variant="ghost" size="sm" onClick={() => setPane("list")}>
              <ChevronLeft /> All components
            </Button>
          </div>
        )}
        <ErrorText error={error} className="p-6 text-sm" />
        {components && components.length === 0 && (
          <div className="mx-auto flex max-w-md flex-col items-center gap-2 px-6 py-24 text-center text-sm text-muted-foreground">
            <LayoutPanelTop className="size-6" />
            <p>No components yet.</p>
            <p>
              Agents build them as they work. Ask for something as UI and say it'll come up again, e.g. “show the open PRs as a table and make it
              reusable”.
            </p>
          </div>
        )}
        {current && (
          <ComponentDetail
            key={`${current.name}@${current.version}`}
            component={current}
            copying={copying === current.name}
            onCopying={(on) => setCopying(on ? current.name : null)}
            onCopied={load}
            onOpen={(name) => {
              setFilter(null);
              open(name);
            }}
          />
        )}
      </div>

      {sharing && (
        <ShareLibraryDialog components={local} initial={current?.source === "local" ? [current.name] : []} onClose={() => setSharing(false)} />
      )}
    </main>
  );
}

const rank = (source: string) => (source === "yaah" ? 0 : source === "local" ? 1 : 2);

/** A component row: open it, copy a library one into your collection or share your own, copy its name. */
function ComponentMenu({
  component: c,
  onOpen,
  onCopy,
  onShare,
  children,
}: {
  component: UiComponent;
  onOpen: () => void;
  onCopy: () => void;
  onShare: () => void;
  children: ReactElement;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>
          <LayoutPanelTop /> Open
        </ContextMenuItem>
        {c.source !== "local" && (
          <ContextMenuItem onSelect={onCopy}>
            <CopyPlus /> Copy to my collection…
          </ContextMenuItem>
        )}
        {c.source === "local" && (
          <ContextMenuItem onSelect={onShare}>
            <Share2 /> Share as library…
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <CopyMenuItem text={c.name}>
          <Copy /> Copy name
        </CopyMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <Button size="xs" variant={active ? "secondary" : "ghost"} aria-pressed={active} className="max-w-full" title={children} onClick={onClick}>
      <span className="truncate">{children}</span>
    </Button>
  );
}

function ComponentDetail({
  component: c,
  copying,
  onCopying,
  onCopied,
  onOpen,
}: {
  component: UiComponent;
  copying: boolean;
  onCopying: (on: boolean) => void;
  onCopied: () => void;
  onOpen: (name: string) => void;
}) {
  const readOnly = c.source !== "local";
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-mono text-base font-medium">{c.name}</h2>
          <Badge variant="secondary">v{c.version}</Badge>
          <Badge variant="outline">{libraryLabel(c)}</Badge>
          <span className="ml-auto text-xs text-muted-foreground">
            {c.source === "yaah"
              ? "ships with yaah · read-only"
              : readOnly
                ? `from ${libraryLabel(c)} · read-only`
                : `updated ${new Date(c.updatedAt * 1000).toLocaleString()}`}
          </span>
        </div>
        <p className="text-sm">{c.description}</p>
        {c.uses.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            Built on
            {c.uses.map((u) => (
              <Badge key={u} variant="outline" className="font-mono text-[10px]">
                {u}
              </Badge>
            ))}
          </div>
        )}
        {c.changeNote && <p className="text-xs text-muted-foreground">Last change: {c.changeNote}</p>}
        {readOnly && <CopyToCollection component={c} editing={copying} onEditing={onCopying} onCopied={onCopied} onOpen={onOpen} />}
      </header>

      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Examples</h3>
        {c.examples.length === 0 && <p className="text-sm text-muted-foreground">No examples.</p>}
        {c.examples.map((ex, i) => (
          <Example key={i} name={c.name} title={ex.title} props={ex.props} />
        ))}
      </section>

      <Raw title="Props schema" value={c.props} />
      <Raw title="Tree" value={c.tree} />
    </div>
  );
}

/** "Copy to my collection", then a name for the copy (its short name to start with). The page owns `editing`, so a row's menu can open it. */
function CopyToCollection({
  component: c,
  editing,
  onEditing: setEditing,
  onCopied,
  onOpen,
}: {
  component: UiComponent;
  editing: boolean;
  onEditing: (on: boolean) => void;
  onCopied: () => void;
  onOpen: (name: string) => void;
}) {
  const [name, setName] = useState(shortName(c.name));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Focus the name once open, after whatever opened the form (a button, or a row's menu) has let go of focus.
  useEffect(() => {
    if (!editing) return;
    const t = setTimeout(() => input.current?.focus());
    return () => clearTimeout(t);
  }, [editing]);

  const copy = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const made = await libraryApi.copyComponent(c.name, name.trim());
      setCopied(made.name);
      setEditing(false);
      onCopied();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (!editing)
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => (setEditing(true), setCopied(null))}>
          <Copy /> Copy to my collection
        </Button>
        {copied && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
            Copied as <span className="font-mono">{copied}</span>.
            <Button size="xs" variant="link" className="h-auto px-0" onClick={() => onOpen(copied)}>
              Open it
            </Button>
          </p>
        )}
      </div>
    );
  return (
    <form
      className="mt-2 flex flex-col gap-1.5 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void copy();
      }}
    >
      <Label htmlFor="copy-name">Name in your collection</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="copy-name"
          ref={input}
          className="max-w-64 flex-1 font-mono text-xs"
          value={name}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={!name.trim() || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Copy />} Copy
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => (setEditing(false), setError(null))}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Your copy is yours to change. References to {libraryLabel(c)}'s other components stay as they are.
      </p>
      <ErrorText error={error} />
    </form>
  );
}

function Example({ name, title, props }: { name: string; title: string; props: Record<string, unknown> }) {
  const [prepared, setPrepared] = useState<{ tree: unknown; props: Record<string, unknown> } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.previewComponent(name, props).then(setPrepared, setError);
  }, [name, props]);

  return (
    <figure className="flex flex-col gap-2 rounded-lg border p-4">
      <figcaption className="text-xs text-muted-foreground">{title}</figcaption>
      <ErrorText error={error} className="text-sm whitespace-pre-wrap" />
      {prepared && <UiTree tree={prepared.tree} props={prepared.props} />}
    </figure>
  );
}

function Raw({ title, value }: { title: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} /> {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{JSON.stringify(value, null, 2)}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
