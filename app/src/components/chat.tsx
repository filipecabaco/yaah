import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  ArrowUp,
  ChevronDown,
  FileText,
  FolderGit2,
  FolderPlus,
  Repeat,
  RotateCw,
  ShieldCheck,
  SquareSlash,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import { AgentMenu } from "@/components/agent-choice";
import { Mark } from "@/components/brand/mark";
import { Hint } from "@/components/shortcuts";
import { ErrorText } from "@/components/error-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { api, type AgentProfile, type Entry, type FileMatch, type Project, type SessionInfo } from "@/lib/api";
import { openInTerminalApp } from "@/lib/terminal-api";
import { onOpenAddRepos, openAddRepos, openAgentSwitch } from "@/lib/app-events";
import { baseName, compactPath, elapsedText, plural, startingText } from "@/lib/format";
import { errorMessage } from "@/lib/narrow";
import type { Starting } from "@/hooks/use-yaah";
import { fuzzyRank } from "@/lib/fuzzy";
import { ChatContext, isFocusedPane, onDraft } from "@/components/chat-context";
import { TranscriptEntry } from "@/components/entries";
import { ToolGroup } from "@/components/tool-group";
import { foldedPermissions } from "@/lib/permissions";
import { isRunning, transcriptRows, useGroupToolCalls } from "@/lib/tool-groups";
import { FolderMenu } from "@/components/menus";
import { useTranscript, useTranscripts } from "@/hooks/use-transcript";

const RepoPicker = lazy(() => import("@/components/repo-picker").then((m) => ({ default: m.RepoPicker })));

type Props = {
  session: SessionInfo;
  agents: AgentProfile[];
  project: Project | null;
  onOpenProject: (id: string) => void;
  onLogin: (accountId: string) => void;
  /** The split pane it is shown in: drafts from its transcript land in its own composer. */
  pane?: string;
};

export function Chat({ session, agents, project, onOpenProject, onLogin, pane }: Props) {
  const agent = agents.find((a) => a.id === session.accountId);
  const roots = [session.cwd, ...session.additionalDirs.filter((d) => d !== project?.contextDir)];
  // Only what deep components need; a stable object, so they don't re-render on every entry.
  const inProject = project != null;
  const chat = useMemo(
    () => ({ sessionId: session.sessionId, cwd: session.cwd, busy: session.running, pane, inProject }),
    [session.sessionId, session.cwd, session.running, pane, inProject],
  );
  // MCP servers whose tools run without asking here: the project's, or a quick chat's own.
  const trusted = project ? (project.trustedMcpServers ?? []) : (session.trustedMcpServers ?? []);
  // "Add repositories…" (⌘K, `/repos`, the folder menu) opens the picker in the pane it came from.
  const [addingRepos, setAddingRepos] = useState(false);
  useEffect(
    () =>
      onOpenAddRepos((r) => {
        if (r.sessionId === session.sessionId && (r.pane === pane || (!r.pane && isFocusedPane(pane)))) setAddingRepos(true);
      }),
    [session.sessionId, pane],
  );

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* Drags the window (its buttons stay buttons): there's no title bar on macOS. */}
      <header data-tauri-drag-region="deep" className="flex items-center gap-2 border-b px-4 py-2.5 text-sm group-data-[many]/pane:pr-11">
        {project && (
          <>
            <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => onOpenProject(project.id)}>
              {project.name}
            </button>
            <span className="text-muted-foreground" aria-hidden>
              /
            </span>
          </>
        )}
        <h1 className="min-w-0 truncate font-medium">{session.title}</h1>
        <button
          type="button"
          className="shrink-0 rounded-4xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          onClick={() => openAgentSwitch(session.sessionId)}
          aria-label={`Agent: ${agent?.label ?? session.accountId}. Switch the agent for the next message`}
          title={agent ? `${agent.detail ?? agent.email ?? agent.commandLine}\nClick to switch the agent for the next message` : undefined}
        >
          <Badge variant="outline" className="gap-1 hover:bg-muted">
            {agent?.label ?? session.accountId}
            <ChevronDown className="size-3 text-muted-foreground" aria-hidden />
          </Badge>
        </button>
        {agent?.report && !agent.report.mcpHttp && (
          <Badge
            variant="secondary"
            className="text-muted-foreground"
            title={`${agent.label} can't connect to HTTP MCP servers, so this chat has no UI tools (forms, tables, charts). Chatting works as usual.`}
          >
            no UI tools
          </Badge>
        )}
        <FolderMenu path={session.cwd}>
          <span className="ml-auto truncate font-mono text-xs text-muted-foreground" title={roots.map((r) => compactPath(r)).join("\n")}>
            {compactPath(session.cwd)}
          </span>
        </FolderMenu>
        <ChatFolders roots={roots} pending={!!session.dirsChanged} inProject={!!project} onAdd={() => openAddRepos(session.sessionId, pane)} />
        {trusted.length > 0 && (
          <TrustedServers
            servers={trusted}
            inProject={!!project}
            onRemove={(server) => (project ? api.untrustProjectMcpServer(project.id, server) : api.untrustChatMcpServer(session.sessionId, server))}
            onManage={project ? () => onOpenProject(project.id) : undefined}
          />
        )}
      </header>
      {addingRepos && (
        <Suspense>
          <RepoPicker
            open
            onClose={() => setAddingRepos(false)}
            exclude={[session.cwd, ...session.additionalDirs]}
            addTo={{ project: project?.name ?? null }}
            onAdd={async (dirs) => void (await api.addChatDirs(session.sessionId, dirs))}
          />
        </Suspense>
      )}

      <ChatContext.Provider value={chat}>
        {/* One per chat: whether it follows the stream, and how far back it shows, are the chat's own. */}
        <Transcript key={session.sessionId} sessionId={session.sessionId} running={session.running} onLogin={onLogin} />
      </ChatContext.Provider>
      <Composer key={session.sessionId} session={session} agentLabel={agent?.label} pane={pane} />
    </div>
  );
}

/** The MCP servers trusted here (the project's, or a quick chat's), each with a way to stop trusting it. */
function TrustedServers({
  servers,
  inProject,
  onRemove,
  onManage,
}: {
  servers: string[];
  inProject: boolean;
  onRemove: (server: string) => Promise<unknown>;
  onManage?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={`${plural(servers.length, "trusted MCP server")} in this ${inProject ? "project" : "chat"}`}
        >
          <ShieldCheck className="size-3.5" aria-hidden />
          <span className="tabular-nums">{servers.length}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-96 min-w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          All tools of these MCP servers run without asking in this {inProject ? "project" : "chat"}, including ones that change things
        </DropdownMenuLabel>
        {servers.map((s) => (
          <DropdownMenuItem
            key={s}
            onSelect={() => void onRemove(s).catch((e: unknown) => console.error("could not stop trusting", s, e))}
            aria-label={`Stop trusting ${s}`}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{s}</span>
            <X className="text-muted-foreground" aria-hidden />
          </DropdownMenuItem>
        ))}
        {onManage && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onManage}>Project settings…</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The chat's folders in its header: how many, a menu listing them, and a way to add repositories. */
function ChatFolders({ roots, pending, inProject, onAdd }: { roots: string[]; pending: boolean; inProject: boolean; onAdd: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={`${plural(roots.length, "folder")} in this chat. Show them or add repositories`}
        >
          <FolderGit2 className="size-3.5" aria-hidden />
          <span className="tabular-nums">{roots.length}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-96 min-w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          {inProject ? "This chat works in its project's folders" : "This chat works in"}
        </DropdownMenuLabel>
        {roots.map((root) => (
          <DropdownMenuItem
            key={root}
            title={`Reveal ${root}`}
            onSelect={() => void revealItemInDir(root).catch((e: unknown) => console.error("could not reveal", root, e))}
          >
            <div className="min-w-0">
              <div className="truncate">{baseName(root)}</div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">{compactPath(root)}</div>
            </div>
          </DropdownMenuItem>
        ))}
        {pending && <p className="px-2 py-1 text-xs text-muted-foreground">New folders reach the agent with your next message.</p>}
        <DropdownMenuSeparator />
        {roots[0] && (
          <DropdownMenuItem onSelect={() => openInTerminalApp(roots[0])}>
            <SquareTerminal /> Open in terminal
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onAdd}>
          <FolderPlus /> Add repositories…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ToolEntry = Extract<Entry, { type: "tool" }>;

/** Entries drawn when a chat opens; earlier ones are added as the user scrolls up to them. */
export const SHOWN = 200;
/** Entries at the end that are always laid out (the rest skip layout while off screen). */
const LIVE_TAIL = 3;

function Transcript({ sessionId, running, onLogin }: { sessionId: string; running: boolean; onLogin: (accountId: string) => void }) {
  const store = useTranscripts();
  const transcript = useTranscript(sessionId);
  const entries = useMemo(() => transcript?.entries ?? [], [transcript]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // The first index drawn: fixed when the chat loads, lowered by "earlier".
  const [start, setStart] = useState<number | null>(null);
  if (transcript && start === null) setStart(Math.max(transcript.from, entries.length - SHOWN));
  const first = start ?? entries.length;
  // Entries after the last user message belong to the current turn.
  const turnStart = entries.findLastIndex((e) => e?.type === "user");
  // Permission prompts carry no input; the tool call they ask about does.
  const toolInputs = useMemo(() => {
    const m = new Map<string, unknown>();
    for (const e of entries) if (e?.type === "tool" && e.rawInput != null) m.set(e.toolCallId, e.rawInput);
    return m;
  }, [entries]);
  // Allowed requests fold into their tool card as a chip; runs of tool calls into one row.
  const folded = useMemo(() => foldedPermissions(entries), [entries]);
  const grouping = useGroupToolCalls();
  const rows = useMemo(() => transcriptRows(entries, first, folded, grouping), [entries, first, folded, grouping]);
  const inTurnAt = (i: number) => running && i > turnStart;
  const entryAt = (i: number) => {
    const entry = entries[i];
    if (!entry) return null;
    return (
      <TranscriptEntry
        entry={entry}
        index={i}
        inTurn={inTurnAt(i)}
        live={inTurnAt(i) && i === entries.length - 1}
        toolInput={entry.type === "permission" && entry.toolCallId ? toolInputs.get(entry.toolCallId) : undefined}
        permission={entry.type === "tool" ? folded.get(entry.toolCallId) : undefined}
        onLogin={onLogin}
      />
    );
  };

  // Follow the stream only while the user is already at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  // Earlier entries go in above what's shown without moving it.
  const heightBefore = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || heightBefore.current == null) return;
    el.scrollTop += el.scrollHeight - heightBefore.current;
    heightBefore.current = null;
  }, [first]);
  const hasEarlier = first > 0 && transcript != null;
  const earlier = useCallback(async () => {
    const t = store.get(sessionId);
    if (!t || start === null || start === 0) return;
    if (start <= t.from) await store.loadEarlier(sessionId);
    heightBefore.current = scroller.current?.scrollHeight ?? null;
    setStart((s) => Math.max(store.get(sessionId)?.from ?? 0, (s ?? 0) - SHOWN));
  }, [store, sessionId, start]);
  const sentinel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasEarlier) return;
    const io = new IntersectionObserver((seen) => {
      if (seen.some((s) => s.isIntersecting)) earlier().catch((e: unknown) => console.error("could not load earlier messages", e));
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasEarlier, earlier]);

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className="@container min-h-0 flex-1 overflow-y-auto"
    >
      {hasEarlier && (
        <button
          ref={sentinel}
          type="button"
          onClick={() => void earlier()}
          className="mx-auto mt-4 block text-xs text-muted-foreground hover:text-foreground"
        >
          Show earlier messages
        </button>
      )}
      <div className="chat-column flex flex-col gap-3 py-6" role="log" aria-label="Conversation" aria-busy={running || !transcript}>
        {transcript?.error ? (
          <TranscriptEntry
            entry={{ type: "error", message: transcript.error, loginAccount: null }}
            index={0}
            inTurn={false}
            live={false}
            onLogin={onLogin}
          />
        ) : !transcript ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          entries.length === 0 && <p className="py-16 text-center text-sm text-muted-foreground">Send a message to start.</p>
        )}
        {rows.map((row) => {
          // Rust addresses entries by index and only ever appends or replaces in place, so the index is a stable key.
          const i = row.kind === "entry" ? row.index : row.indices[0];
          const last = row.kind === "entry" ? row.index : row.indices[row.indices.length - 1];
          // Off-screen entries skip layout and paint (content-visibility), so long chats open fast.
          const offScreen = last < entries.length - LIVE_TAIL ? "transcript-entry" : undefined;
          if (row.kind === "entry")
            return (
              <div key={i} className={offScreen}>
                {entryAt(i)}
              </div>
            );
          const tools = row.indices.map((j) => entries[j]).filter((e): e is ToolEntry => e?.type === "tool");
          return (
            <div key={`g${i}`} className={offScreen}>
              <ToolGroup
                id={`${sessionId}:${i}`}
                tools={tools}
                running={row.indices.map((j, k) => isRunning(tools[k], inTurnAt(j)))}
                autoAllowed={tools.filter((t) => ["readOnly", "trustedServer"].includes(folded.get(t.toolCallId)?.auto?.reason ?? "")).length}
                card={(k) => entryAt(row.indices[k])}
              />
            </div>
          );
        })}
        {running && entries[entries.length - 1]?.type === "user" && <p className="text-xs text-muted-foreground">Working…</p>}
      </div>
    </div>
  );
}

/** What the text before the caret is asking to complete: `/cmd` at the start, or `@file` anywhere. */
type Trigger = { kind: "command" | "file"; start: number; query: string };

function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { kind: "command", start: 0, query: slash[1] };
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: "file", start: caret - at[2].length - 1, query: at[2] };
  return null;
}

type Suggestion = {
  id: string;
  label: string;
  detail?: string;
  hint?: string;
  insert: string;
  path?: string;
  /** One of yaah's own commands: runs here, never sent to the agent. */
  local?: () => void;
  /** Its icon in the list, when not the default. */
  icon?: ReactNode;
};

/** yaah's own slash commands, listed before the agent's. */
const localCommands = (session: SessionInfo, pane?: string): (Suggestion & { name: string })[] => [
  {
    id: "yaah:agent",
    name: "agent",
    label: "/agent",
    detail: "Switch the agent for the next message",
    insert: "",
    local: () => openAgentSwitch(session.sessionId),
  },
  {
    id: "yaah:repos",
    name: "repos",
    label: "/repos",
    detail: session.projectId ? "Add repositories to this project" : "Add repositories to this chat",
    insert: "",
    icon: <FolderPlus />,
    local: () => openAddRepos(session.sessionId, pane),
  },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `@label` still standing as its own word in the text. */
const mentioned = (text: string, label: string) => new RegExp(`(^|\\s)@${escapeRe(label)}(?=\\s|$)`).test(text);

function Composer({ session, agentLabel, pane }: { session: SessionInfo; agentLabel?: string; pane?: string }) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [error, setError] = useState<unknown>(null);
  /** Files picked from the @ list: label → absolute path. */
  const [mentions, setMentions] = useState<Record<string, string>>({});
  /** The last file search, for the @ trigger that started at `start`. */
  const [found, setFound] = useState<{ start: number; files: FileMatch[] } | null>(null);
  const [active, setActive] = useState(0);
  /** Start of a trigger closed with Esc; it stays closed until it's gone. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [focused, setFocused] = useState(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const moveCaret = useRef<number | null>(null);
  const listId = useId();

  // Other components (e.g. "Ask about this" on a diff) can draft into this composer.
  useEffect(
    () =>
      onDraft(
        ({ text: add, mention }) => {
          const next = text.trim() ? `${text.replace(/\s*$/, "")}\n${add}` : add;
          moveCaret.current = next.length;
          setText(next);
          setCaret(next.length);
          if (mention) setMentions((m) => ({ ...m, [mention.label]: mention.path }));
          setTimeout(() => input.current?.focus());
        },
        session.sessionId,
        pane,
      ),
    [text, session.sessionId, pane],
  );

  const trigger = useMemo(() => findTrigger(text, caret), [text, caret]);
  if (!trigger && dismissed !== null) setDismissed(null);
  const open = trigger && trigger.start !== dismissed ? trigger : null;
  const openKind = open?.kind ?? null;
  const openQuery = open?.query ?? "";
  const openStart = open?.start ?? -1;

  // File search runs in Rust over the chat's folders; debounce the keystrokes.
  const fileQuery = openKind === "file" ? openQuery : null;
  useEffect(() => {
    if (fileQuery == null) return;
    let stale = false;
    const t = setTimeout(() => {
      api.searchFiles(session.sessionId, fileQuery, 20).then(
        (files) => !stale && setFound({ start: openStart, files }),
        (e: unknown) => {
          if (stale) return;
          setFound({ start: openStart, files: [] });
          console.error("file search failed", e);
        },
      );
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [fileQuery, openStart, session.sessionId]);
  const files = fileQuery != null && found?.start === openStart ? found.files : null;

  const items: Suggestion[] = useMemo(() => {
    if (openKind === "command") {
      const own = fuzzyRank(localCommands(session, pane), openQuery, (c) => [c.name, c.detail ?? ""]);
      const agents = fuzzyRank(session.commands, openQuery, (c) => [c.name, c.description]).map((c) => ({
        id: c.name,
        label: `/${c.name}`,
        detail: c.description,
        hint: c.input?.hint,
        insert: `/${c.name} `,
      }));
      return [...own, ...agents];
    }
    if (openKind === "file") return (files ?? []).map((f) => ({ id: f.path, label: f.label, insert: `@${f.label} `, path: f.path }));
    return [];
  }, [openKind, openQuery, session, pane, files]);

  // A new list starts at its first item.
  const listKey = `${openKind}:${openQuery}`;
  const [activeFor, setActiveFor] = useState(listKey);
  if (activeFor !== listKey) {
    setActiveFor(listKey);
    setActive(0);
  }
  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);
  useLayoutEffect(() => {
    if (moveCaret.current == null) return;
    input.current?.setSelectionRange(moveCaret.current, moveCaret.current);
    moveCaret.current = null;
  }, [text]);

  /** One of yaah's own commands: it runs here; the command goes, and what was typed after it stays. */
  function runLocal(run: () => void) {
    setText(text.slice(caret).replace(/^\S*/, "").replace(/^ /, ""));
    setCaret(0);
    run();
  }

  function accept(s: Suggestion) {
    if (!open) return;
    if (s.local) return runLocal(s.local);
    // Replace the whole token under the caret, plus one following space.
    const rest = text.slice(caret).replace(/^\S*/, "").replace(/^ /, "");
    const pos = open.start + s.insert.length;
    setText(text.slice(0, open.start) + s.insert + rest);
    setCaret(pos);
    moveCaret.current = pos;
    const path = s.path;
    if (path) setMentions((m) => ({ ...m, [s.label]: path }));
  }

  async function send() {
    const prompt = text.trim();
    if (!prompt) return;
    const own = localCommands(session, pane).find((c) => prompt === c.label);
    if (own) {
      setText("");
      own.local?.();
      return;
    }
    if (session.running) return;
    setError(null);
    const paths = Object.entries(mentions)
      .filter(([label]) => mentioned(prompt, label))
      .map(([, path]) => path);
    try {
      await api.sendPrompt(session.sessionId, prompt, paths);
      setText("");
      setMentions({});
    } catch (e) {
      setError(e);
    }
  }

  function stop() {
    setError(null);
    api.cancelTurn(session.sessionId).catch(setError);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (open && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDismissed(open.start);
      return;
    }
    const plain = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (open && items.length && plain) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(items[Math.min(active, items.length - 1)]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const showList = open != null && focused;
  // yaah's own commands, then the agent's; files in one group.
  const groups = (
    openKind === "command"
      ? [
          { heading: "yaah", list: items.filter((s) => s.local) },
          { heading: `Commands from ${agentLabel ?? "the agent"}`, list: items.filter((s) => !s.local) },
        ]
      : [{ heading: "Files in this chat's folders", list: items }]
  ).filter((g) => g.list.length > 0);
  return (
    // The composer lines up with the transcript's column: the same edges as the cards and UI above it.
    <div className="@container border-t py-3">
      <div className="chat-column relative flex items-end gap-2">
        {showList && (
          <Command
            ref={list}
            shouldFilter={false}
            vimBindings={false}
            value={items[active]?.id ?? ""}
            onValueChange={(v) =>
              setActive(
                Math.max(
                  0,
                  items.findIndex((s) => s.id === v),
                ),
              )
            }
            // Keep focus in the textarea when an item is clicked.
            onMouseDown={(e) => e.preventDefault()}
            className="absolute bottom-full left-(--chat-gutter) z-10 mb-2 h-auto w-[min(42rem,calc(100%-2*var(--chat-gutter)))] shadow-md ring-1 ring-foreground/10"
          >
            <CommandList id={listId}>
              {items.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {open.kind === "command"
                    ? session.commands.length
                      ? "No command matches."
                      : "This chat has no slash commands yet."
                    : files == null
                      ? "Searching…"
                      : "No file matches."}
                </p>
              ) : (
                <>
                  {groups.map((g) => (
                    <CommandGroup key={g.heading} heading={g.heading}>
                      {g.list.map((s) => (
                        <CommandItem key={s.id} value={s.id} onSelect={() => accept(s)}>
                          {s.icon ?? (s.local ? <Repeat /> : open.kind === "command" ? <SquareSlash /> : <FileText />)}
                          {s.path ? <FileLabel label={s.label} /> : <span className="shrink-0 font-mono">{s.label}</span>}
                          {s.local && (
                            <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[10px]" title="yaah's own command, not sent to the agent">
                              yaah
                            </Badge>
                          )}
                          {s.detail && <span className="truncate text-muted-foreground">{s.detail}</span>}
                          {s.hint && <CommandShortcut className="shrink-0 tracking-normal italic">‹{s.hint}›</CommandShortcut>}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ))}
                </>
              )}
            </CommandList>
            <footer className="flex items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
              <span>
                <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
              </span>
              <span>
                <Kbd>↵</Kbd> or <Kbd>Tab</Kbd> accept
              </span>
              <span className="ml-auto">
                <Kbd>Esc</Kbd> close
              </span>
            </footer>
          </Command>
        )}
        <Textarea
          data-composer
          ref={input}
          // Only the pane the user is in takes the focus (a restored layout opens several chats at once).
          autoFocus={isFocusedPane(pane)}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={`Message ${agentLabel ?? "the agent"}…  / for commands, @ to mention a file`}
          aria-label="Message"
          className="max-h-48 min-h-10 resize-none"
          rows={1}
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-autocomplete="list"
        />
        {session.running ? (
          <Hint label="Stop" shortcut="stop">
            <Button size="icon" variant="secondary" onClick={stop} aria-label="Stop">
              <Square />
            </Button>
          </Hint>
        ) : (
          <Hint label="Send ↵">
            <Button size="icon" onClick={() => void send()} disabled={!text.trim()} aria-label="Send">
              <ArrowUp />
            </Button>
          </Hint>
        )}
      </div>
      <ErrorText error={error} className="chat-column mt-1" />
    </div>
  );
}

/** `src/billing/invoice.ts` with the file name standing out. */
function FileLabel({ label }: { label: string }) {
  const cut = label.lastIndexOf("/") + 1;
  return (
    <span className="min-w-0 truncate">
      <span className="font-medium">{label.slice(cut)}</span>
      {cut > 0 && <span className="ml-2 font-mono text-xs text-muted-foreground">{label.slice(0, cut)}</span>}
    </span>
  );
}

/** Seconds since `since`, ticking each second. */
function useSecondsSince(since: number, ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** After this many seconds the starting view shows how long it has been. */
const SHOW_ELAPSED_AFTER = 2;

/**
 * A new chat while its agent starts and `session/new` runs (use-yaah.ts `startIn`): the agent,
 * the sliding mark, what it is waiting for, and the time so far once it takes a while. The
 * composer waits (nothing queues a message yet). A failed start shows why, with Retry and
 * Switch agent.
 */
export function StartingChat({ start, agents, onDismiss }: { start: Starting; agents: AgentProfile[]; onDismiss: () => void }) {
  const agent = agents.find((a) => a.id === start.agentId);
  const label = agent?.label ?? start.agentId;
  const failed = start.error != null;
  const seconds = useSecondsSince(start.startedAt, !failed);
  const others = agents.filter((a) => a.id !== start.agentId);
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header data-tauri-drag-region="deep" className="flex items-center gap-2 border-b px-4 py-2.5 text-sm group-data-[many]/pane:pr-11">
        <h1 className="min-w-0 truncate font-medium">New chat</h1>
        <Badge variant="outline">{label}</Badge>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {failed ? (
          <div className="mx-auto w-full max-w-[75ch] px-4 py-16">
            <div role="alert" className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
              <div className="flex items-center gap-2 font-medium text-destructive">
                <AlertTriangle className="size-4 shrink-0" aria-hidden />
                {label} didn't start
              </div>
              <p className="text-xs [overflow-wrap:anywhere] whitespace-pre-wrap text-destructive">{errorMessage(start.error)}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => start.retry()}>
                  <RotateCw /> Retry
                </Button>
                {others.length > 0 && (
                  <AgentMenu agents={others} heading="Start it with…" onPick={(id) => start.retry(id)}>
                    <Button size="sm" variant="outline">
                      Switch agent <ChevronDown />
                    </Button>
                  </AgentMenu>
                )}
                <Button size="sm" variant="ghost" onClick={onDismiss}>
                  Close
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div
            role="status"
            aria-live="polite"
            aria-label={`Starting a chat with ${label}`}
            className="flex flex-col items-center gap-3 px-4 py-16 text-center"
          >
            <Mark loading className="size-8 text-foreground" />
            <p className="max-w-[60ch] text-sm font-medium">{startingText(start, label)}</p>
            {seconds >= SHOW_ELAPSED_AFTER && <p className="text-xs text-muted-foreground tabular-nums">{elapsedText(seconds)}</p>}
          </div>
        )}
      </div>
      <div className="@container border-t py-3">
        <div className="chat-column flex items-end gap-2">
          <Textarea
            disabled
            placeholder={failed ? `${label} didn't start` : `${label} is starting…`}
            aria-label="Message"
            className="max-h-48 min-h-10 resize-none"
            rows={1}
          />
          <Button size="icon" disabled aria-label="Send">
            <ArrowUp />
          </Button>
        </div>
      </div>
    </div>
  );
}
