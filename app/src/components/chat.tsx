import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { displayTitle } from "@/lib/chat-title";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FileText,
  FolderGit2,
  FolderPlus,
  ListPlus,
  Plug,
  Repeat,
  RotateCw,
  ShieldCheck,
  SquareSlash,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import { AgentMenu } from "@/components/agent-choice";
import { ComposerConfig } from "@/components/composer-config";
import { ModeStatus } from "@/components/composer-mode";
import { COMPOSER_INPUT, ComposerShell, TRIGGER_HELP, TriggerHint } from "@/components/composer-shell";
import { CommandDialog } from "@/components/command-dialog";
import { commandOf, runCommand } from "@/lib/slash-commands";
import { ComposerQueue } from "@/components/composer-queue";
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
import { api, type AgentProfile, type Entry, type FileMatch, type Project, type SessionInfo, type SlashCommand } from "@/lib/api";
import { openInTerminalApp } from "@/lib/terminal-api";
import { SCOPE_WORDS, trustApi, useTrustView, type TrustScope, type TrustView } from "@/lib/trust-api";
import { onOpenAddRepos, openAddRepos, openAgentSwitch } from "@/lib/app-events";
import { baseName, compactPath, elapsedText, plural, startingText } from "@/lib/format";
import { errorMessage } from "@/lib/narrow";
import type { Starting } from "@/hooks/use-yaah";
import { fuzzyRank } from "@/lib/fuzzy";
import { applyEdit, markdownKey, pasteLink } from "@/lib/markdown-input";
import { isMac } from "@/lib/shortcuts";
import { MarkdownTextarea } from "@/components/markdown-textarea";
import { cycleMode } from "@/lib/app-events";
import { modeOption, nextSafeMode } from "@/lib/permission-modes";
import { ChatContext, isFocusedPane, onDraft } from "@/components/chat-context";
import { TranscriptEntry, WaitingChip } from "@/components/entries";
import { ToolGroup } from "@/components/tool-group";
import { PermissionDock } from "@/components/permission-dock";
import { SubagentCard } from "@/components/subagent-card";
import { SubagentStrip } from "@/components/subagent-strip";
import { agentSummary } from "@/lib/subagents";
import { WorkingIndicator } from "@/components/working-indicator";
import { turnPhase, useTurnStart } from "@/lib/working";
import { pendingBatch } from "@/lib/permission-batch";
import { foldedPermissions, isAutoAllowed } from "@/lib/permissions";
import { isRunning, transcriptRows, useGroupToolCalls } from "@/lib/tool-groups";
import { FolderMenu } from "@/components/menus";
import { useTranscript, useTranscripts } from "@/hooks/use-transcript";
import { AttachButton, AttachmentChips, DropOverlay } from "@/components/composer-attachments";
import { ReferenceChips, ReferenceRow } from "@/components/references";
import { ActiveDescendant } from "@/components/active-descendant";
import { useReferenceSuggestions } from "@/hooks/use-reference-suggestions";
import { loadDraft, saveDraft } from "@/lib/composer-draft";
import { connectLabel, findReferenceTrigger, referenceHeading, standing } from "@/lib/references";
import { openSettings } from "@/lib/app-events";
import type { Reference, ReferenceService } from "@/lib/api";
import { useChatDrop, useComposerAttachments } from "@/hooks/use-attachments";

const RepoPicker = lazy(() => import("@/components/repo-picker").then((m) => ({ default: m.RepoPicker })));

type Props = {
  session: SessionInfo;
  agents: AgentProfile[];
  project: Project | null;
  /** Stable, so a memoised chat is not redrawn with every change elsewhere: it names its own pane. */
  onOpenProject: (pane: string, id: string) => void;
  onLogin: (accountId: string) => void;
  /** The split pane it is shown in: drafts from its transcript land in its own composer. */
  pane: string;
};

export const Chat = memo(function Chat({ session, agents, project, onOpenProject, onLogin, pane }: Props) {
  const agent = agents.find((a) => a.id === session.accountId);
  const roots = [session.cwd, ...session.additionalDirs.filter((d) => d !== project?.contextDir)];
  // Only what deep components need; a stable object, so they don't re-render on every entry.
  const inProject = project != null;
  const chat = useMemo(
    () => ({ sessionId: session.sessionId, cwd: session.cwd, busy: session.running, pane, inProject }),
    [session.sessionId, session.cwd, session.running, pane, inProject],
  );
  // MCP servers whose tools run without asking here: every server trusted here, with the scope that trusts it (session/trust.rs); re-read on a move to a project.
  const trustView = useTrustView(session.sessionId, `${session.projectId ?? ""}|${session.cwd}`);
  // "Add repositories…" (⌘K, `/repos`, the folder menu) opens the picker in the pane it came from.
  const [addingRepos, setAddingRepos] = useState(false);
  useEffect(
    () =>
      onOpenAddRepos((r) => {
        if (r.sessionId === session.sessionId && (r.pane === pane || (!r.pane && isFocusedPane(pane)))) setAddingRepos(true);
      }),
    [session.sessionId, pane],
  );
  // Files dropped anywhere on the pane attach to its composer (components/composer-attachments.tsx).
  const dropRoot = useRef<HTMLDivElement>(null);
  const { drag, handlers: dropHandlers } = useChatDrop(dropRoot, session.sessionId, pane);

  return (
    // `@container/chat`: the header drops what matters least as its pane narrows (in rem, so it follows the interface size).
    <div ref={dropRoot} {...dropHandlers} data-chat-root className="@container/chat relative flex h-full min-w-0 flex-1 flex-col">
      {/* Drags the window (its buttons stay buttons): there's no title bar on macOS. */}
      <header
        data-tauri-drag-region="deep"
        className="flex items-center gap-2 border-b px-4 py-2.5 text-sm group-data-[many]/pane:py-1.5 group-data-[many]/pane:pr-11"
      >
        {project && (
          <>
            <button
              type="button"
              className="max-w-[40%] min-w-0 shrink truncate text-muted-foreground hover:text-foreground"
              title={project.name}
              onClick={() => onOpenProject(pane, project.id)}
            >
              {project.name}
            </button>
            <span className="text-muted-foreground" aria-hidden>
              /
            </span>
          </>
        )}
        {/* The title gives way last: the folder path shrinks first and goes in a narrow pane; the full title is its tooltip. */}
        <h1 className="min-w-[4ch] truncate font-medium" title={displayTitle(session.title)}>
          {displayTitle(session.title)}
        </h1>
        <button
          type="button"
          className="flex min-h-[24px] shrink-0 items-center rounded-4xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
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
            className="hidden text-muted-foreground @md/chat:inline-flex group-data-[many]/pane:@md/chat:hidden"
            title={`${agent.label} can't connect to HTTP MCP servers, so this chat has no UI tools (forms, tables, charts). Chatting works as usual.`}
          >
            no UI tools
          </Badge>
        )}
        <FolderMenu path={session.cwd}>
          <span
            className="ml-auto hidden min-w-0 shrink-[4] truncate font-mono text-xs text-muted-foreground @lg/chat:block group-data-[many]/pane:@lg/chat:hidden"
            title={roots.map((r) => compactPath(r)).join("\n")}
          >
            {compactPath(session.cwd)}
          </span>
        </FolderMenu>
        <ChatFolders roots={roots} pending={!!session.dirsChanged} inProject={!!project} onAdd={() => openAddRepos(session.sessionId, pane)} />
        {trustView && (trustView.servers.length > 0 || trustView.shellRules.length > 0) && (
          <TrustedServers
            view={trustView}
            onRemove={(server, scope) =>
              scope === "everywhere"
                ? trustApi.untrustEverywhere(server)
                : scope === "quickChats"
                  ? trustApi.untrustQuickChats(server)
                  : scope === "project" && project
                    ? api.untrustProjectMcpServer(project.id, server)
                    : api.untrustChatMcpServer(session.sessionId, server)
            }
            onForgetRule={(rule, scope) => trustApi.forgetShellRule(session.sessionId, rule, scope)}
            onManage={project ? () => onOpenProject(pane, project.id) : undefined}
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
      <ComposerQueue session={session} pane={pane} />
      {/* A waiting permission request is answered here, always in the same place (components/permission-dock.tsx). */}
      <ChatContext.Provider value={chat}>
        <PermissionDock session={session} />
      </ChatContext.Provider>
      <Composer key={session.sessionId} session={session} agentLabel={agent?.label} pane={pane} />
      <DropOverlay drag={drag} agent={agent?.label ?? "This agent"} report={agent?.report} />
    </div>
  );
});

/**
 * The MCP servers trusted here (this chat's, its project's or quick chats', and all chats'), each with
 * the scope that trusts it and a way to stop trusting it there.
 */
function TrustedServers({
  view,
  onRemove,
  onForgetRule,
  onManage,
}: {
  view: TrustView;
  onRemove: (server: string, scope: TrustScope) => Promise<unknown>;
  onForgetRule: (rule: string, scope: TrustScope) => Promise<unknown>;
  onManage?: () => void;
}) {
  const { servers, shellRules, here } = view;
  const count = servers.length + shellRules.length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex min-h-[24px] shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={`${[servers.length > 0 && plural(servers.length, "trusted MCP server"), shellRules.length > 0 && plural(shellRules.length, "allowed command rule")].filter(Boolean).join(" and ")} ${SCOPE_WORDS[here]}`}
        >
          <ShieldCheck className="size-3.5" aria-hidden />
          <span className="tabular-nums">{count}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-96 min-w-64">
        {servers.length > 0 && (
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            All tools of these MCP servers run without asking {SCOPE_WORDS[here]}, including ones that change things
          </DropdownMenuLabel>
        )}
        {servers.map((s) => (
          <DropdownMenuItem
            key={`${s.scope}:${s.id}`}
            onSelect={() => void onRemove(s.id, s.scope).catch((e: unknown) => console.error("could not stop trusting", s.id, e))}
            aria-label={`Stop trusting ${s.id} ${SCOPE_WORDS[s.scope]}`}
          >
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{s.id}</span>
            {s.scope !== here && <span className="shrink-0 text-2xs text-muted-foreground">{SCOPE_WORDS[s.scope]}</span>}
            <X className="text-muted-foreground" aria-hidden />
          </DropdownMenuItem>
        ))}
        {shellRules.length > 0 && (
          <>
            {servers.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Commands starting with these run without asking, when every part of the command matches one
            </DropdownMenuLabel>
            {shellRules.map((r) => (
              <DropdownMenuItem
                key={`${r.scope}:${r.rule}`}
                onSelect={() => void onForgetRule(r.rule, r.scope).catch((e: unknown) => console.error("could not forget", r.rule, e))}
                aria-label={`Stop allowing ${r.rule} commands ${SCOPE_WORDS[r.scope]}`}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.rule}</span>
                {r.scope !== here && <span className="shrink-0 text-2xs text-muted-foreground">{SCOPE_WORDS[r.scope]}</span>}
                <X className="text-muted-foreground" aria-hidden />
              </DropdownMenuItem>
            ))}
          </>
        )}
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
          // Right-aligned by the folder path beside it; on its own once a narrow pane drops the path.
          className="ml-auto flex min-h-[24px] shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none @lg/chat:ml-0"
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
              <div className="truncate font-mono text-2xs text-muted-foreground">{compactPath(root)}</div>
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
  const batch = useMemo(() => pendingBatch(entries), [entries]);
  const inTurnAt = (i: number) => running && i > turnStart;
  const agents = useMemo(() => agentSummary(entries, (i) => running && i > turnStart), [entries, running, turnStart]);
  const turnSince = useTurnStart(sessionId, running, turnStart);
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

  // Whether the user has scrolled away from the end (shows "Jump to latest").
  const [away, setAway] = useState(false);
  const lastTop = useRef(0);
  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const pin = useCallback(
    (on: boolean) => {
      pinned.current = on;
      setAway(!on);
      if (on) toBottom();
    },
    [toBottom],
  );

  // Follow the stream only while the user is already at the bottom; a message they send brings them back.
  const seen = useRef(entries.length);
  useEffect(() => {
    const sent = entries.length > seen.current && entries[entries.length - 1]?.type === "user";
    seen.current = entries.length;
    if (sent) pin(true);
    else if (pinned.current) toBottom();
  }, [entries, pin, toBottom]);

  // The log keeps growing after it draws: entries laid out for the first time (they start as a
  // 120px estimate, see .transcript-entry), charts and maps that load, code that highlights.
  // While pinned, every growth keeps the end in view, so a chat opens at its last message.
  const column = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = column.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);

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
    <div className="relative flex min-h-0 flex-1 flex-col">
      <SubagentStrip agents={agents} />
      <div
        ref={scroller}
        // Scrolling up is the user taking the wheel: let go of the end now, before the next
        // layout growth can pull them back (a small nudge stays inside the 40px "at end" band).
        onWheel={(e) => {
          if (e.deltaY < 0 && pinned.current && e.currentTarget.scrollHeight > e.currentTarget.clientHeight) {
            pinned.current = false;
            setAway(true);
          }
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          // Only the user moving up lets go of the end. Content growing, or the browser
          // keeping the view steady while entries above lay out, never does.
          const up = el.scrollTop < lastTop.current;
          lastTop.current = el.scrollTop;
          if (atEnd !== pinned.current && (atEnd || up)) {
            pinned.current = atEnd;
            setAway(!atEnd);
          }
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
        <div
          ref={column}
          data-copy-on-select
          className="chat-column flex flex-col gap-3 py-6 group-data-[many]/pane:gap-2 group-data-[many]/pane:py-3"
          role="log"
          aria-label="Conversation"
          aria-busy={running || !transcript}
        >
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
            const i = row.kind === "group" ? row.indices[0] : row.index;
            const last = row.kind === "group" ? row.indices[row.indices.length - 1] : row.kind === "batch" ? entries.length : row.index;
            // Off-screen entries skip layout and paint (content-visibility), so long chats open fast.
            const offScreen = last < entries.length - LIVE_TAIL ? "transcript-entry" : undefined;
            if (row.kind === "entry")
              return (
                <div key={i} className={offScreen}>
                  {entryAt(i)}
                </div>
              );
            if (row.kind === "batch") {
              const items = (batch?.items ?? []).flatMap((m) => {
                const entry = entries[m.index];
                return entry?.type === "permission"
                  ? [{ ...m, entry, toolInput: entry.toolCallId ? toolInputs.get(entry.toolCallId) : undefined }]
                  : [];
              });
              if (items.length < 2) return null;
              return (
                <div key={`b${i}`} className={offScreen}>
                  <WaitingChip what={`${items.length} permission requests`} />
                </div>
              );
            }
            if (row.kind === "agent") {
              const tool = entries[row.index];
              if (tool?.type !== "tool") return null;
              const calls = row.inside.map((j) => entries[j]).filter((e): e is ToolEntry => e?.type === "tool");
              return (
                <div key={i} className={offScreen}>
                  <SubagentCard
                    id={`${sessionId}:agent:${tool.toolCallId}`}
                    tool={tool}
                    inTurn={inTurnAt(row.index)}
                    calls={calls}
                    items={row.inside.map((j) => {
                      const e = entries[j];
                      return { index: j, waiting: e?.type === "permission" && e.chosen == null };
                    })}
                    card={entryAt}
                    asking={row.asking}
                  />
                </div>
              );
            }
            const tools = row.indices.map((j) => entries[j]).filter((e): e is ToolEntry => e?.type === "tool");
            return (
              <div key={`g${i}`} className={offScreen}>
                <ToolGroup
                  id={`${sessionId}:${i}`}
                  tools={tools}
                  running={row.indices.map((j, k) => isRunning(tools[k], inTurnAt(j)))}
                  autoAllowed={tools.filter((t) => isAutoAllowed(folded.get(t.toolCallId))).length}
                  card={(k) => entryAt(row.indices[k])}
                />
              </div>
            );
          })}
          {running && turnSince != null && (
            <WorkingIndicator
              phase={turnPhase(entries, turnStart)}
              since={turnSince}
              agents={agents.filter((a) => a.status === "running" || a.status === "background").length}
            />
          )}
        </div>
      </div>
      {away && entries.length > 0 && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-md"
          onClick={() => pin(true)}
        >
          <ArrowDown /> Jump to latest
        </Button>
      )}
    </div>
  );
}

/** What the text before the caret is asking to complete: `/cmd` at the start, `@file` anywhere, or a `#` reference (lib/references.ts). */
type Trigger = { kind: "command" | "file" | "reference"; start: number; query: string; service?: ReferenceService | null; link?: boolean };

function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { kind: "command", start: 0, query: slash[1] };
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: "file", start: caret - at[2].length - 1, query: at[2] };
  const ref = findReferenceTrigger(text, caret);
  if (ref) return { kind: "reference", ...ref };
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
  /** A tracker item from the `#` list: drawn as one, remembered once picked. */
  reference?: Reference;
  /** Runs instead of inserting, leaving the text as it is (e.g. open Settings → Integrations). */
  action?: () => void;
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
  // The composer remounts per chat, so the unsent text is kept per session (lib/composer-draft.ts).
  const [draft] = useState(() => loadDraft(session.sessionId));
  const [text, setText] = useState(draft?.text ?? "");
  const [caret, setCaret] = useState(draft?.text.length ?? 0);
  const [error, setError] = useState<unknown>(null);
  /** A model or effort pick the agent refused (shown under the frame, with the send error). */
  const [configError, setConfigError] = useState<unknown>(null);
  /** Files picked from the @ list: label → absolute path. */
  const [mentions, setMentions] = useState<Record<string, string>>(draft?.mentions ?? {});
  /** Tracker items picked from the # list, by token (Rust reads every token in the text on send). */
  const [picked, setPicked] = useState<Record<string, Reference>>(draft?.picked ?? {});
  const [sending, setSending] = useState(false);
  /** The last file search, for the @ trigger that started at `start`. */
  const [found, setFound] = useState<{ start: number; files: FileMatch[] } | null>(null);
  const [active, setActive] = useState(0);
  /** Start of a trigger closed with Esc; it stays closed until it's gone. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [focused, setFocused] = useState(true);
  useEffect(() => saveDraft(session.sessionId, { text, mentions, picked }), [session.sessionId, text, mentions, picked]);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const moveCaret = useRef<number | null>(null);
  const listId = useId();
  // Dropped text goes in at the caret; dropped, pasted and picked files become attachments.
  const attached = useComposerAttachments(session.sessionId, pane, (add) => {
    const at = Math.min(caret, text.length);
    moveCaret.current = at + add.length;
    setText(text.slice(0, at) + add + text.slice(at));
    setCaret(at + add.length);
    input.current?.focus();
  });

  // Other components (e.g. "Ask about this" on a diff) can draft into this composer.
  useEffect(
    () =>
      onDraft(
        ({ text: add, mention, mentions: more = [] }) => {
          const next = text.trim() ? `${text.replace(/\s*$/, "")}\n${add}` : add;
          moveCaret.current = next.length;
          setText(next);
          setCaret(next.length);
          const all = mention ? [mention, ...more] : more;
          if (all.length) setMentions((m) => ({ ...m, ...Object.fromEntries(all.map((x) => [x.label, x.path])) }));
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

  // `#` references: Rust searches the connected trackers and ranks (debounced, cached there).
  const refService = open?.kind === "reference" ? (open.service ?? null) : null;
  const refs = useReferenceSuggestions(
    session.sessionId,
    open?.kind === "reference" ? { service: refService, query: openQuery, link: !!open.link } : null,
  );

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
    if (openKind === "reference") {
      if (refs.connected?.length === 0)
        return [
          {
            id: "yaah:connect",
            label: connectLabel(refService),
            detail: "Settings → Integrations",
            insert: "",
            action: () => openSettings("integrations"),
          },
        ];
      return (refs.items ?? []).map((r) => ({ id: r.token, label: r.token, insert: `${r.token} `, reference: r }));
    }
    return [];
  }, [openKind, openQuery, session, pane, files, refs.connected, refs.items, refService]);

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
    if (s.action) {
      setDismissed(open.start);
      return s.action();
    }
    // Replace the whole token under the caret, plus one following space.
    const rest = text.slice(caret).replace(/^\S*/, "").replace(/^ /, "");
    const pos = open.start + s.insert.length;
    setText(text.slice(0, open.start) + s.insert + rest);
    setCaret(pos);
    moveCaret.current = pos;
    const path = s.path;
    if (path) setMentions((m) => ({ ...m, [s.label]: path }));
    const reference = s.reference;
    if (reference) setPicked((p) => ({ ...p, [reference.token]: reference }));
  }

  const [held, setHeld] = useState<{ command: SlashCommand; text: string } | null>(null);

  async function send(now = false) {
    const prompt = text.trim();
    if ((!prompt && !attached.items.length) || attached.pending) {
      // Ctrl/⌘+Enter on an empty box joins the queue into one message.
      if (now && !prompt && !attached.items.length && (session.queue?.items?.length ?? 0) > 0) {
        setError(null);
        api.queueMerge(session.sessionId).catch(setError);
      }
      return;
    }
    const own = localCommands(session, pane).find((c) => prompt === c.label);
    if (own) {
      setText("");
      own.local?.();
      return;
    }
    // A slash command during a turn isn't a message to queue: a dialog asks when it should run.
    const command = session.running ? commandOf(prompt, session.commands) : undefined;
    if (command) {
      if (!now) return setHeld({ command, text: prompt });
      // Ctrl/⌘+Enter: no questions, stop the turn and run it.
      setError(null);
      try {
        await runCommand(session.sessionId, prompt, true);
        setText("");
      } catch (e) {
        setError(e);
      }
      return;
    }
    // While a turn runs Rust queues the message instead (session/queue.rs); the composer clears either way.
    setError(null);
    const paths = Object.entries(mentions)
      .filter(([label]) => mentioned(prompt, label))
      .map(([, path]) => path);
    // References in the text are read in Rust before the turn starts; the chips say so meanwhile.
    setSending(true);
    try {
      const files = attached.items.map((a) => a.id);
      const sent = await api.sendPrompt(session.sessionId, prompt, paths, files);
      // Ctrl/⌘+Enter: what is queued, this message included, becomes one message.
      if (now && sent.status === "queued") await api.queueMerge(session.sessionId);
      setText("");
      setMentions({});
      setPicked({});
      attached.clear();
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
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
    // Markdown help: lists continue on Shift+Enter, Tab indents an item, marks wrap a selection.
    const el = e.currentTarget;
    const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    const md = markdownKey(
      e.nativeEvent,
      { text: el.value, start: el.selectionStart, end: el.selectionEnd },
      { listOpen: !!(open && items.length), mod },
    );
    if (md) {
      e.preventDefault();
      // ⌘B over a selection is bold here, not the sidebar.
      e.stopPropagation();
      applyEdit(el, md);
      return;
    }
    // Shift+Tab cycles the permission mode, as in the CLI (never into an unrestricted one). While a turn
    // runs, or with no other mode to go to, it stays the browser's own "previous field".
    if (e.key === "Tab" && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !session.running) {
      const mode = modeOption(session);
      if (mode && nextSafeMode(mode)) {
        e.preventDefault();
        cycleMode(session.sessionId, pane);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(e.ctrlKey || e.metaKey);
    }
  }

  // A pasted link only opens the list when Rust says it is a PR, MR or issue.
  const showList = open != null && focused && !(open.link && items.length === 0);
  // yaah's own commands, then the agent's; files in one group; references in one.
  const groups = (
    openKind === "command"
      ? [
          { heading: "yaah", list: items.filter((s) => s.local) },
          { heading: `Commands from ${agentLabel ?? "the agent"}`, list: items.filter((s) => !s.local) },
        ]
      : openKind === "reference"
        ? [{ heading: referenceHeading(refService), list: items }]
        : [{ heading: "Files in this chat's folders", list: items }]
  ).filter((g) => g.list.length > 0);
  const attaches = Object.values(picked).filter((r) => standing(text, r.token));
  const carrying = attached.items.length > 0 || attached.refused.length > 0 || attached.pending || attaches.length > 0;
  const hintId = `${listId}-hint`;
  return (
    // The composer lines up with the transcript's column: the same edges as the cards and UI above it.
    // One frame (components/composer-shell.tsx) holds the chips, the message box and the toolbar.
    <div className="@container pt-2 pb-3">
      <div className="chat-column">
        {/* The suggestion list anchors just above the frame. */}
        <div className="relative">
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
              className="absolute bottom-full left-0 z-10 mb-2 h-auto w-[min(42rem,100%)] shadow-md ring-1 ring-foreground/10"
            >
              {/* The textarea is the combobox: it names the highlighted option. */}
              <ActiveDescendant target={input} list={list} />
              <CommandList id={listId}>
                {items.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    {open.kind === "command"
                      ? session.commands.length
                        ? "No command matches."
                        : "This chat has no slash commands yet."
                      : open.kind === "reference"
                        ? refs.items == null
                          ? "Searching…"
                          : open.query
                            ? "Nothing matches. Keep typing to search, or paste a link."
                            : "Nothing recent here."
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
                            {s.reference ? (
                              <ReferenceRow reference={s.reference} />
                            ) : (
                              (s.icon ?? (s.local ? <Repeat /> : open.kind === "command" ? <SquareSlash /> : s.action ? <Plug /> : <FileText />))
                            )}
                            {s.reference ? null : s.path ? (
                              <FileLabel label={s.label} />
                            ) : (
                              <span className={s.action ? "shrink-0" : "shrink-0 font-mono"}>{s.label}</span>
                            )}
                            {s.local && (
                              <Badge variant="secondary" className="h-4 shrink-0 px-1 text-2xs" title="yaah's own command, not sent to the agent">
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
                {open.kind === "reference" &&
                  refs.errors.map((e) => (
                    <p key={e.service} className="px-3 py-1.5 text-xs [overflow-wrap:anywhere] text-destructive" role="status">
                      {e.message}
                    </p>
                  ))}
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
          <ComposerShell
            input={input}
            carrying={carrying}
            carries={
              // The tokens stay plain text (robust to edit, undo, copy); what they'll attach shows beside the files.
              <AttachmentChips sessionId={session.sessionId} state={attached}>
                {attaches.length > 0 && <ReferenceChips references={attaches} sending={sending} />}
              </AttachmentChips>
            }
            toolbar={
              <>
                <AttachButton onPick={attached.pick} />
                {/* Model and effort, when the agent offers them (components/composer-config.tsx). */}
                <ComposerConfig session={session} pane={pane} onError={setConfigError} />
                <div className="ml-auto flex shrink-0 items-center gap-2 pl-1">
                  <TriggerHint />
                  {session.running ? (
                    <>
                      {/* While a turn runs, a message waits in the chat's queue (Enter does the same). */}
                      {(text.trim() || attached.items.length > 0) && (
                        <Hint label="Queue ↵">
                          <Button size="icon-sm" variant="outline" onClick={() => void send()} disabled={attached.pending} aria-label="Queue message">
                            <ListPlus />
                          </Button>
                        </Hint>
                      )}
                      <Hint label="Stop" shortcut="stop">
                        <Button size="icon-sm" variant="secondary" onClick={stop} aria-label="Stop">
                          <Square />
                        </Button>
                      </Hint>
                    </>
                  ) : (
                    <Hint label="Send ↵">
                      <Button
                        size="icon-sm"
                        onClick={() => void send()}
                        disabled={(!text.trim() && !attached.items.length) || attached.pending}
                        aria-label="Send"
                      >
                        <ArrowUp />
                      </Button>
                    </Hint>
                  )}
                </div>
              </>
            }
          >
            <MarkdownTextarea
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
              onPaste={(e) => {
                // A URL pasted over selected text becomes a link; files and images go to the attachments.
                const el = e.currentTarget;
                const link = e.clipboardData.files.length
                  ? null
                  : pasteLink({ text: el.value, start: el.selectionStart, end: el.selectionEnd }, e.clipboardData.getData("text/plain"));
                if (link) {
                  e.preventDefault();
                  applyEdit(el, link);
                  return;
                }
                attached.onPaste(e);
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              // Short, so it fits a narrow pane; the triggers are in the toolbar and the description.
              placeholder={`Message ${agentLabel ?? "the agent"}…`}
              aria-label="Message"
              aria-describedby={hintId}
              className={COMPOSER_INPUT}
              overlayClassName="px-3 pt-2.5 pb-1"
              rows={1}
              role="combobox"
              aria-expanded={showList}
              aria-controls={showList ? listId : undefined}
              aria-autocomplete="list"
            />
          </ComposerShell>
        </div>
        {held && (
          <CommandDialog
            sessionId={session.sessionId}
            command={held.command}
            text={held.text}
            running={session.running}
            onClose={() => setHeld(null)}
            onDone={() => setText("")}
          />
        )}
        <p id={hintId} className="sr-only">
          {TRIGGER_HELP}
        </p>
        <ModeStatus session={session} />
        <ErrorText error={error} className="mt-1.5" />
        <ErrorText error={configError} className="mt-1.5" />
      </div>
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
      {/* The same frame as the chat's composer, so nothing jumps when the chat opens. */}
      <div className="@container pt-2 pb-3">
        <div className="chat-column">
          <ComposerShell
            toolbar={
              <Button size="icon-sm" disabled aria-label="Send" className="ml-auto">
                <ArrowUp />
              </Button>
            }
          >
            <Textarea
              disabled
              placeholder={failed ? `${label} didn't start` : `${label} is starting…`}
              aria-label="Message"
              className={COMPOSER_INPUT}
              rows={1}
            />
          </ComposerShell>
        </div>
      </div>
    </div>
  );
}
