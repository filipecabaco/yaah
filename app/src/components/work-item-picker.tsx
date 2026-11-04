// "New project → From an issue": your open issues and Linear projects across
// GitHub, Linear and GitLab, fuzzy-searchable, or any one by pasting its URL or
// id. Starting one makes the project, opens its chat and drafts the prompt
// there (never sends it). Rust fetches, resolves and creates; this only shows.
import { useEffect, useMemo, useRef, useState } from "react";
import { Inbox, Loader2, Search } from "lucide-react";
import { draftIntoChat } from "@/components/chat-context";
import { ErrorText } from "@/components/error-text";
import { ServiceBadge, ServiceIcon } from "@/components/work-items";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type StartedProject, type WorkItem, type WorkQueue } from "@/lib/api";
import { fuzzyRank } from "@/lib/fuzzy";
import { hasRelation, looksLikeRef, sameItem, searchText, SERVICES, TRACKER_INTEGRATIONS, type RelationFilter } from "@/lib/work-items";
import { cn } from "@/lib/utils";

export type WorkItemPickerProps = {
  /** Starts the project (or finds the one following the item) and opens its new chat, or the project when there's none. */
  onStart: (item: WorkItem) => Promise<StartedProject>;
  /** An item a project already follows: open that project. */
  onOpenProject: (id: string) => void;
  /** Settings → Integrations, on a service when given. */
  onIntegrations: (service?: string) => void;
  /** Close the dialog. */
  onDone: () => void;
};

type Resolved = { input: string; item?: WorkItem; error?: unknown };

const key = (i: WorkItem) => `${i.service}:${i.id}`;

export function WorkItemPicker({ onStart, onOpenProject, onIntegrations, onDone }: WorkItemPickerProps) {
  const [queue, setQueue] = useState<WorkQueue | null>(null);
  /** Whether any tracker is connected; null until known. */
  const [connected, setConnected] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [relation, setRelation] = useState<RelationFilter>("all");
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Mounted each time the dialog opens on this mode: a fresh read of every service.
  useEffect(() => {
    let live = true;
    api.integrationsStatus().then((list) => {
      if (live) setConnected(list.some((s) => TRACKER_INTEGRATIONS.includes(s.id) && s.connected));
    }, setLoadError);
    api.workQueue().then((q) => live && setQueue(q), setLoadError);
    return () => {
      live = false;
    };
  }, []);

  // A pasted URL or id: Rust says what it is (after a pause in typing).
  const ref = looksLikeRef(query) ? query.trim() : null;
  useEffect(() => {
    if (!ref) return;
    let live = true;
    const t = setTimeout(() => {
      api.resolveWorkItem(ref).then(
        (item) => live && setResolved({ input: ref, item }),
        (e: unknown) => live && setResolved({ input: ref, error: e }),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ref]);
  const lookup = ref && resolved?.input === ref ? resolved : null;
  const resolving = !!ref && !lookup;

  const rows = useMemo(() => {
    const matches = fuzzyRank(
      (queue?.items ?? []).filter((i) => hasRelation(i, relation)),
      query,
      (i) => [searchText(i)],
    );
    const pasted = lookup?.item;
    return pasted ? [pasted, ...matches.filter((m) => !sameItem(m, pasted))] : matches;
  }, [queue, relation, query, lookup]);

  // The highlight starts on the first row each time the list changes.
  const [moved, setMoved] = useState<{ in: WorkItem[]; at: number } | null>(null);
  const cursor = moved?.in === rows ? moved.at : 0;
  const setCursor = (at: number) => setMoved({ in: rows, at });

  async function start(item: WorkItem) {
    if (busy) return;
    if (item.projectId) {
      onOpenProject(item.projectId);
      return onDone();
    }
    setBusy(key(item));
    setError(null);
    try {
      const started = await onStart(item);
      // No chat (chatError): the project page opens instead and says why.
      if (started.chatId && started.draft) draftIntoChat(started.chatId, { text: started.draft });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  function onSearchKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, Math.min(rows.length - 1, cursor + (e.key === "ArrowDown" ? 1 : -1)));
      setCursor(next);
      listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[cursor]) void start(rows[cursor]);
    }
  }

  if (connected === false) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center">
        <Inbox className="size-6 text-muted-foreground" aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">No tracker connected</p>
          <p className="max-w-sm text-sm text-pretty text-muted-foreground">
            Connect GitHub, Linear or GitLab to start projects from your issues and Linear projects. yaah only reads them.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => onIntegrations()}>
          Open Settings → Integrations
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            role="combobox"
            aria-label="Search issues"
            aria-expanded
            aria-controls="work-item-list"
            aria-autocomplete="list"
            aria-activedescendant={rows[cursor] ? `work-item-${cursor}` : undefined}
            placeholder="Search your issues, or paste a URL or id…"
            className="pr-8 pl-8"
          />
          {resolving && (
            <Loader2 className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-label="Looking it up" />
          )}
        </div>
        <Tabs value={relation} onValueChange={(v) => setRelation(v as RelationFilter)}>
          <TabsList aria-label="Show">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="assigned">Assigned</TabsTrigger>
            <TabsTrigger value="created">Created</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {lookup?.error != null && <ErrorText error={lookup.error} prefix="Couldn't open that: " />}
      <ErrorText error={loadError} prefix="Couldn't read your issues: " />

      {queue && queue.errors.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Services that didn't answer">
          {queue.errors.map((e) => {
            const { label, integration } = SERVICES[e.service];
            return (
              <li key={e.service} className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs">
                <ServiceIcon service={e.service} className="text-destructive" />
                <span className="min-w-0 flex-1 break-words text-destructive">
                  {!e.message.startsWith(label) && <span className="font-medium">{label}: </span>}
                  {e.message}
                </span>
                {e.kind === "auth" && (
                  <Button size="xs" variant="outline" onClick={() => onIntegrations(integration)} aria-label={`Reconnect ${label}`}>
                    Reconnect
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div ref={listRef} id="work-item-list" role="listbox" aria-label="Issues" className="-mx-1 h-80 overflow-y-auto px-1">
        {queue == null && loadError == null ? (
          <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" /> Reading your issues…
          </p>
        ) : rows.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">
            {query.trim()
              ? resolving
                ? "Looking it up…"
                : "Nothing matches. Paste an issue's URL or id to start from any item."
              : relation === "all"
                ? "Nothing open for you right now. Paste an issue's URL or id to start from any item."
                : `Nothing ${relation === "assigned" ? "assigned to you" : "you created"} is open.`}
          </p>
        ) : (
          rows.map((item, i) => {
            const starting = busy === key(item);
            return (
              <div
                key={key(item)}
                id={`work-item-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === cursor}
                aria-label={`${item.id} ${item.title}`}
                onClick={() => void start(item)}
                onMouseMove={() => i !== cursor && setCursor(i)}
                className={cn(
                  "group/row flex cursor-default items-center gap-3 rounded-md px-2 py-2",
                  i === cursor && "bg-muted",
                  busy && !starting && "opacity-60",
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm font-medium">{item.title}</span>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <ServiceBadge service={item.service} />
                    <span className="font-mono">{item.id}</span>
                    {item.status && <span>· {item.status}</span>}
                    {item.labels.map((l) => (
                      <Badge key={l} variant="secondary" className="h-4 px-1.5 text-2xs font-normal">
                        {l}
                      </Badge>
                    ))}
                  </div>
                </div>
                <span className={cn("shrink-0 text-xs whitespace-nowrap text-muted-foreground", i === cursor && "text-foreground")}>
                  {starting ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="size-3 animate-spin" /> starting…
                    </span>
                  ) : item.projectId ? (
                    "open →"
                  ) : (
                    "start →"
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>

      <ErrorText error={error} className="text-sm whitespace-pre-wrap" />
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> to choose
        </span>
        <span>
          <Kbd>↵</Kbd> to start, or open the project that follows it
        </span>
        <span>
          <Kbd>esc</Kbd> to close
        </span>
      </p>
    </div>
  );
}
