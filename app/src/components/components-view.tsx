import { useEffect, useState } from "react";
import { ChevronRight, LayoutPanelTop, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ErrorText } from "@/components/error-text";
import { UiTree } from "@/components/ui-render";
import { api, type UiComponent } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Browse the shared UI library agents build and improve. */
export function ComponentsView() {
  const [components, setComponents] = useState<UiComponent[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  function load() {
    api.listComponents().then((list) => {
      setError(null);
      setComponents(list);
      setSelected((s) => s ?? list[0]?.name ?? null);
    }, setError);
  }
  useEffect(load, []);

  const current = components?.find((c) => c.name === selected) ?? null;
  // What ships with the app first; then what agents built.
  const groups: [string, UiComponent[]][] = [
    ["Provided by yaah", components?.filter((c) => c.source === "yaah") ?? []],
    ["Built by agents", components?.filter((c) => c.source !== "yaah") ?? []],
  ];

  return (
    <main className="flex min-w-0 flex-1">
      <div className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-sm font-medium">Component library</h1>
          <Button variant="ghost" size="icon-xs" onClick={load} title="Refresh" aria-label="Refresh components">
            <RefreshCw />
          </Button>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
          {groups.map(([title, list]) =>
            list.length ? (
              <div key={title} className="flex flex-col gap-0.5">
                <h2 className="px-2 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
                {list.map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    aria-current={c.name === selected || undefined}
                    onClick={() => setSelected(c.name)}
                    className={cn(
                      "flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted",
                      c.name === selected && "bg-muted",
                    )}
                  >
                    <span className="flex w-full items-center gap-1.5 text-sm">
                      <span className="truncate font-mono text-xs">{c.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground">v{c.version}</span>
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{c.description}</span>
                  </button>
                ))}
              </div>
            ) : null,
          )}
        </nav>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
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
        {current && <ComponentDetail key={`${current.name}@${current.version}`} component={current} />}
      </div>
    </main>
  );
}

function ComponentDetail({ component: c }: { component: UiComponent }) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="font-mono text-base font-medium">{c.name}</h2>
          <Badge variant="secondary">v{c.version}</Badge>
          <Badge variant="outline">{c.source}</Badge>
          <span className="ml-auto text-xs text-muted-foreground">
            {c.source === "yaah" ? "ships with yaah · read-only" : `updated ${new Date(c.updatedAt * 1000).toLocaleString()}`}
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
