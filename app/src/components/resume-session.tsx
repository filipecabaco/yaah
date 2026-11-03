// "Resume a session…": pick an agent profile that lists its sessions, then one of its sessions
// (started in its CLI, say) through a search; Enter brings it in as a chat and opens it. Rust
// lists (`list_agent_sessions`, on that profile's own agent) and imports (`import_agent_session`);
// this only shows what comes back. Used by the ⌘K palette and by a new pane's picker.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Bot, History, Loader2, MessageSquare } from "lucide-react";
import { ErrorText } from "@/components/error-text";
import { Badge } from "@/components/ui/badge";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { agentDetail, api, mayListSessions, type AgentProfile, type AgentSession } from "@/lib/api";
import { baseName, compactPath, formatAgo } from "@/lib/format";
import { rankTop } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";

/** Sessions shown at most; typing finds the rest. */
const LIMIT = 100;
const NONE: AgentSession[] = [];

type Listing =
  | { state: "loading" }
  | { state: "error"; error: unknown }
  | { state: "ready"; sessions: AgentSession[]; nextCursor: string | null; more: "idle" | "loading" | { error: unknown } };

export function ResumeSession({
  agents,
  onResume,
  onBack,
  autoFocus = true,
  inPane = false,
}: {
  agents: AgentProfile[];
  /** Bring the session in and open it; resolves once it's open. */
  onResume: (accountId: string, session: AgentSession) => Promise<unknown>;
  /** Back out of the first step: ⌫ on an empty search (and Esc in a pane). */
  onBack: () => void;
  autoFocus?: boolean;
  /** In a pane rather than the palette: Esc goes back instead of closing a dialog. */
  inPane?: boolean;
}) {
  const listable = useMemo(() => agents.filter(mayListSessions), [agents]);
  const cannot = agents.filter((a) => !mayListSessions(a));
  // With one agent that can list, its sessions come straight away.
  const [accountId, setAccountId] = useState<string | null>(listable.length === 1 ? listable[0].id : null);
  const agent = agents.find((a) => a.id === accountId) ?? null;
  const [search, setSearch] = useState("");
  // The last listing, and whose it is: another agent's shows as loading until this one's answers.
  const [fetched, setFetched] = useState<{ of: string; listing: Listing } | null>(null);
  const listing: Listing = fetched && fetched.of === accountId ? fetched.listing : { state: "loading" };
  const setListing = (f: (l: Listing) => Listing) =>
    setFetched((prev) => (prev && prev.of === accountId ? { ...prev, listing: f(prev.listing) } : prev));
  const [opening, setOpening] = useState<{ id: string; error: unknown } | null>(null);
  const [active, setActive] = useState<{ id: string; query: string } | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let live = true;
    api.listAgentSessions(accountId).then(
      (page) =>
        live && setFetched({ of: accountId, listing: { state: "ready", sessions: page.sessions, nextCursor: page.nextCursor, more: "idle" } }),
      (error: unknown) => live && setFetched({ of: accountId, listing: { state: "error", error } }),
    );
    return () => {
      live = false;
    };
  }, [accountId]);

  const pickAgent = (id: string) => {
    setSearch("");
    setOpening(null);
    // Asked afresh each time it's picked.
    setFetched(null);
    setAccountId(id);
  };
  const back = () => {
    if (accountId && listable.length > 1) {
      setAccountId(null);
      setSearch("");
      setOpening(null);
    } else onBack();
  };

  const loadMore = () => {
    if (!accountId || listing.state !== "ready" || !listing.nextCursor || listing.more === "loading") return;
    const cursor = listing.nextCursor;
    setListing((l) => (l.state === "ready" ? { ...l, more: "loading" } : l));
    api.listAgentSessions(accountId, undefined, cursor).then(
      (page) =>
        setListing((l) =>
          l.state === "ready" && l.nextCursor === cursor
            ? { state: "ready", sessions: [...l.sessions, ...page.sessions], nextCursor: page.nextCursor, more: "idle" }
            : l,
        ),
      (error: unknown) => setListing((l) => (l.state === "ready" ? { ...l, more: { error } } : l)),
    );
  };

  const open = (s: AgentSession) => {
    if (!agent || opening?.error === null) return;
    setOpening({ id: s.sessionId, error: null });
    onResume(agent.id, s).catch((error: unknown) => setOpening({ id: s.sessionId, error: error ?? "it didn't open" }));
  };

  const query = search.trim();
  const sessions = listing.state === "ready" ? listing.sessions : NONE;
  const ranked = useMemo(() => rankTop(sessions, query, (s) => [s.title ?? "", baseName(s.cwd), compactPath(s.cwd)], LIMIT), [sessions, query]);
  const agentsRanked = rankTop(listable, query, (a) => [a.label, a.presetLabel]);

  let body: ReactNode;
  let placeholder: string;
  let ids: string[];
  if (!agent) {
    placeholder = "Resume a session from…";
    ids = agentsRanked.shown.map((a) => `resume-agent-${a.id}`);
    body =
      listable.length === 0 ? (
        <Note>None of your agents can list their sessions. Claude Code and Codex can.</Note>
      ) : (
        <CommandGroup heading="Resume a session from">
          {agentsRanked.shown.map((a) => (
            <CommandItem key={a.id} value={`resume-agent-${a.id}`} onSelect={() => pickAgent(a.id)}>
              <Bot />
              <span className="truncate">{a.label}</span>
              <Detail>{agentDetail(a) || a.presetLabel}</Detail>
            </CommandItem>
          ))}
        </CommandGroup>
      );
  } else {
    placeholder = `Search ${agent.label}'s sessions…`;
    const more = listing.state === "ready" && listing.nextCursor && !query ? ["resume-more"] : [];
    ids = [...ranked.shown.map((s) => `resume-${s.sessionId}`), ...more];
    if (listing.state === "loading") {
      body = (
        <Note>
          <Loader2 className="size-4 animate-spin" aria-hidden /> Asking {agent.label} for its sessions…
        </Note>
      );
    } else if (listing.state === "error") {
      body = <ErrorText error={listing.error} className="px-3 py-4" />;
    } else if (listing.sessions.length === 0) {
      body = <Note>{agent.label} has no sessions yet. Ones you start in its CLI show up here.</Note>;
    } else {
      body = (
        <CommandGroup heading={`${agent.label}'s sessions`}>
          {ranked.shown.length === 0 && <Note>Nothing matches.</Note>}
          {ranked.shown.map((s) => {
            const busy = opening?.id === s.sessionId && opening.error === null;
            return (
              <CommandItem key={s.sessionId} value={`resume-${s.sessionId}`} onSelect={() => open(s)} className="gap-2">
                {busy ? <Loader2 className="animate-spin" /> : s.alreadyInYaah ? <MessageSquare /> : <History />}
                <span className={cn("min-w-0 flex-1 truncate", !s.title && "text-muted-foreground italic")}>{s.title ?? "Untitled session"}</span>
                {s.alreadyInYaah && (
                  <Badge variant="secondary" className="shrink-0 font-normal">
                    Already in yaah
                  </Badge>
                )}
                <Detail title={compactPath(s.cwd)}>{baseName(s.cwd)}</Detail>
                {s.updatedAt != null && (
                  <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{formatAgo(s.updatedAt)}</span>
                )}
              </CommandItem>
            );
          })}
          {ranked.more > 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{ranked.more} more: type to find them.</p>}
          {more.length > 0 && listing.state === "ready" && (
            <CommandItem value="resume-more" onSelect={loadMore}>
              {listing.more === "loading" ? <Loader2 className="animate-spin" /> : <History />}
              <span className="text-muted-foreground">{listing.more === "loading" ? "Loading older sessions…" : "Load older sessions"}</span>
            </CommandItem>
          )}
          {typeof listing.more === "object" && <ErrorText error={listing.more.error} className="px-2 py-1" />}
        </CommandGroup>
      );
    }
  }
  // Each search starts on its best match.
  const value = active?.query === query && ids.includes(active.id) ? active.id : (ids[0] ?? "");

  return (
    <Command
      shouldFilter={false}
      vimBindings={false}
      value={value}
      onValueChange={(id) => setActive({ id, query })}
      label="Resume a session"
      className={inPane ? "h-auto rounded-xl! border shadow-xs" : undefined}
    >
      <CommandInput
        autoFocus={autoFocus}
        data-pane-autofocus={inPane || undefined}
        value={search}
        onValueChange={setSearch}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Backspace" && !search) {
            e.preventDefault();
            back();
          } else if (e.key === "Escape" && inPane) {
            e.preventDefault();
            e.stopPropagation();
            if (search) setSearch("");
            else back();
          }
        }}
      />
      <CommandList className={inPane ? "max-h-[50vh]" : "max-h-96"}>{body}</CommandList>
      {opening?.error != null && <ErrorText error={opening.error} className="border-t px-3 py-2" />}
      {cannot.length > 0 && !agent && (
        <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
          {cannot.map((a) => a.label).join(", ")} can't list {cannot.length === 1 ? "its" : "their"} sessions.
        </p>
      )}
      <footer className="flex items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
        </span>
        <span>
          <Kbd>↵</Kbd> {agent ? "open" : "pick"}
        </span>
        <span>
          <Kbd>⌫</Kbd> back
        </span>
        {opening?.error === null && (
          <span className="flex items-center gap-1" role="status">
            <Loader2 className="size-3 animate-spin" aria-hidden /> Bringing in its history…
          </span>
        )}
        <span className="ml-auto">
          <Kbd>Esc</Kbd> {inPane ? (search ? "clear" : "back") : "close"}
        </span>
      </footer>
    </Command>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="flex items-center justify-center gap-2 px-3 py-6 text-center text-sm text-pretty text-muted-foreground">{children}</p>;
}

/** A secondary detail, which gives way before the label in a narrow pane. */
function Detail({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <Badge variant="outline" title={title} className="max-w-40 min-w-12 shrink-[4] justify-start font-normal text-muted-foreground">
      <span className="truncate">{children}</span>
    </Badge>
  );
}
