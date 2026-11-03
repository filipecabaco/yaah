// One component per kind of transcript entry. Rust owns the transcript; these
// only draw it. Every entry is memoised on the entry object itself (Rust sends
// a new object only for the entry that changed), so a streaming reply
// re-renders one entry, not the whole chat.
import { memo, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  FilePen,
  FileText,
  FolderPlus,
  Globe,
  Info,
  Loader2,
  LogIn,
  Paperclip,
  Pencil,
  Quote,
  Repeat,
  Search,
  ShieldCheck,
  ShieldQuestion,
  ShieldX,
  SquareTerminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Markdown } from "@/components/markdown";
import { ErrorText } from "@/components/error-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CopyMenu, type MenuAction } from "@/components/menus";
import { draftIntoComposer, useChat } from "@/components/chat-context";
import { PatchView, TextDiff } from "@/components/ui-render";
import { ToolTerminal } from "@/components/terminal/tool-terminal";
import { FolderRequestEntry, UiEntry } from "@/components/ui-entry";
import { api, type Entry, type ToolContent } from "@/lib/api";
import { openSettings } from "@/lib/app-events";
import { permissionAnswer, permissionChip, type PermissionEntry } from "@/lib/permissions";
import { baseName, compactPath, elapsedText, plural } from "@/lib/format";
import { cardKey, cardKeyLabel, cardMode, saveCardRule, useCardRules, type CardMode } from "@/lib/tool-cards";
import { readToolText, toolTextLayout } from "@/lib/tool-output";
import { cn } from "@/lib/utils";
import { toolLabel } from "@/lib/ui-tool-label";

type Of<T extends Entry["type"]> = Extract<Entry, { type: T }>;

type EntryProps = {
  entry: Entry;
  index: number;
  /** The entry belongs to the turn that is running now. */
  inTurn: boolean;
  /** The last entry of the running turn (a thought still being written). */
  live: boolean;
  /** For a permission: the input of the tool call it asks about, if known. */
  toolInput?: unknown;
  /** For a tool call: the allowed permission request folded into its card, shown as a chip. */
  permission?: PermissionEntry;
  onLogin: (accountId: string) => void;
};

/** One transcript entry. Re-renders only when its own entry or position in the turn changes. */
export const TranscriptEntry = memo(function TranscriptEntry({ entry, index, inTurn, live, toolInput, permission, onLogin }: EntryProps) {
  switch (entry.type) {
    case "user":
      return <UserMessage entry={entry} />;
    case "agent":
      return <AgentMessage entry={entry} />;
    case "thought":
      return <Thought entry={entry} live={live} />;
    case "tool":
      return <ToolCall entry={entry} turnActive={inTurn} permission={permission} />;
    case "plan":
      return <Plan entry={entry} />;
    case "permission":
      return <Permission entry={entry} index={index} toolInput={toolInput} />;
    case "ui":
      return <UiEntry entry={entry} index={index} />;
    case "error":
      return <ErrorEntry entry={entry} onLogin={onLogin} />;
    case "notices":
      return <NoticesEntry entry={entry} />;
    case "switch":
      return <SwitchEntry entry={entry} />;
    case "addedDirs":
      return <AddedDirsEntry entry={entry} />;
    case "folderRequest":
      return <FolderRequestEntry entry={entry} index={index} />;
  }
});

/** `text` as a Markdown quote, ready for a reply below it. */
const quoted = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n") + "\n\n";

function UserMessage({ entry }: { entry: Of<"user"> }) {
  const pane = useChat()?.pane;
  return (
    <div data-align="end" className="ml-auto flex w-fit max-w-[min(75ch,85%)] flex-col items-end gap-1 text-sm">
      <CopyMenu
        act={() => [{ label: "Edit as new message", icon: <Pencil />, onSelect: () => draftIntoComposer({ text: entry.text }, pane) }]}
        actions={[{ label: "Copy text", text: () => entry.text }]}
      >
        <div className="max-w-full rounded-lg bg-muted px-3 py-2 [overflow-wrap:anywhere] whitespace-pre-wrap">{entry.text}</div>
      </CopyMenu>
      {entry.attachments.length > 0 && (
        <div className="flex gap-1">
          {entry.attachments.map((a) => (
            <Badge key={a} variant="outline" className="gap-1 text-muted-foreground">
              <Paperclip className="size-3" /> {a}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The agent's text in a soft bubble on the left, mirroring the user's on the right: a muted fill
 * with no border, so it reads as conversation rather than another card. Each text run is its own
 * entry, so a reply split around tool calls gets one bubble per run. It fills the column up to a
 * readable measure (a fixed width, so it doesn't widen as text streams in, and charts or diagrams
 * inside have a width to fill); `.agent-reply` in index.css loosens the prose spacing inside.
 */
function AgentMessage({ entry }: { entry: Of<"agent"> }) {
  const pane = useChat()?.pane;
  // A run that hasn't streamed any text yet would be an empty bubble.
  if (!entry.text.trim()) return null;
  return (
    <CopyMenu
      // The selected part of this message, if any; else all of it.
      act={(t) => [
        { label: "Quote in reply", icon: <Quote />, onSelect: () => draftIntoComposer({ text: quoted(t.ownSelection || entry.text) }, pane) },
      ]}
      actions={[{ label: "Copy text", text: () => entry.text }]}
    >
      <div
        data-align="start"
        className="agent-reply w-fit max-w-[min(140ch,100%)] rounded-lg bg-muted/50 px-4 py-3 text-sm leading-relaxed [overflow-wrap:anywhere]"
      >
        <Markdown>{entry.text}</Markdown>
      </div>
    </CopyMenu>
  );
}

function Thought({ entry, live }: { entry: Of<"thought">; live: boolean }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
        <Brain className="size-3" />
        {live ? "Thinking…" : "Thought"}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 max-w-[85ch] border-l-2 pl-3 text-xs whitespace-pre-wrap text-muted-foreground">{entry.text}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const TOOL_ICONS: Record<string, typeof Wrench> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: FilePen,
  search: Search,
  execute: SquareTerminal,
  think: Brain,
  fetch: Globe,
};

function StatusBadge({ status }: { status: Of<"tool">["status"] }) {
  switch (status) {
    case "completed":
      return (
        <Badge variant="outline" className="gap-1">
          <Check className="size-3" /> done
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="gap-1">
          <X className="size-3" /> failed
        </Badge>
      );
    case "in_progress":
      return (
        <Badge variant="secondary" className="gap-1">
          <Loader2 className="size-3 animate-spin" /> running
        </Badge>
      );
    default:
      return <Badge variant="secondary">pending</Badge>;
  }
}

/** When each running UI tool call was first seen, so its time so far survives re-renders and remounts. */
const firstSeen = new Map<string, number>();

/** "12 s", "2 min 5 s": how long a UI tool call has been running, ticking each second. */
export function Elapsed({ id }: { id: string }) {
  const [started] = useState(() => {
    const t = firstSeen.get(id) ?? Date.now();
    firstSeen.set(id, t);
    return t;
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const s = Math.floor((now - started) / 1000);
  if (s < 1) return null;
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums" aria-label={`running for ${elapsedText(s)}`}>
      {elapsedText(s)}
    </span>
  );
}

const RULE_ACTIONS: { mode: CardMode; label: (like: string) => string; icon: typeof Wrench }[] = [
  { mode: "collapsed", label: (like) => `Always collapse “${like}”`, icon: ChevronRight },
  { mode: "expanded", label: (like) => `Always expand “${like}”`, icon: ChevronDown },
  { mode: "auto", label: (like) => `Open “${like}” only while it runs`, icon: Wrench },
];

/** A tool call. How its card opens is a rule per kind of tool (Settings → Chat): `auto` opens it while its turn runs. */
function ToolCall({ entry, turnActive, permission }: { entry: Of<"tool">; turnActive: boolean; permission?: PermissionEntry }) {
  const key = cardKey(entry.title, entry.kind);
  const mode = cardMode(useCardRules(), key);
  const wanted = mode === "expanded" || (mode === "auto" && turnActive);
  const [open, setOpen] = useState(wanted);
  // The rule or the turn changed: follow it (the user can still toggle in between).
  const [lastWanted, setLastWanted] = useState(wanted);
  if (wanted !== lastWanted) {
    setLastWanted(wanted);
    setOpen(wanted);
  }
  const Icon = TOOL_ICONS[entry.kind ?? ""] ?? Wrench;
  const output = toolOutput(entry.content);
  const label = toolLabel({ title: entry.title, status: entry.status, rawInput: entry.rawInput, output });
  const hasBody = entry.content.length > 0 || entry.rawInput != null;
  const copyActions = [{ label: "Copy title", text: () => entry.title }];
  if (entry.rawInput != null) copyActions.push({ label: "Copy input", text: () => JSON.stringify(entry.rawInput, null, 2) });
  if (output) copyActions.push({ label: "Copy output", text: () => output });
  const paths = toolPaths(entry);
  if (paths.length) copyActions.push({ label: paths.length === 1 ? "Copy file path" : "Copy file paths", text: () => paths.join("\n") });
  const like = cardKeyLabel(key);
  const extra: MenuAction[] = RULE_ACTIONS.filter((a) => a.mode !== mode).map(({ mode, label, icon: I }) => ({
    label: label(like),
    icon: <I />,
    onSelect: () => {
      saveCardRule(key, mode).catch((e: unknown) => console.error("could not save the card rule", e));
    },
  }));

  return (
    <CopyMenu actions={copyActions} extra={extra}>
      <Collapsible open={open && hasBody} onOpenChange={setOpen} className="rounded-lg border bg-card">
        <CollapsibleTrigger disabled={!hasBody} className="group flex w-full items-center gap-2 px-3 py-2 text-left text-sm">
          {label?.busy ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-brand" aria-hidden />
          ) : (
            <Icon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="flex min-w-0 flex-1 items-baseline gap-2 text-xs" title={entry.title}>
            <span className={cn("truncate", !label && "font-mono")}>{label ? label.text : entry.title}</span>
            {label?.detail && <span className="truncate text-muted-foreground">{label.detail}</span>}
          </span>
          {permission && <AllowedChip entry={permission} />}
          {label?.busy ? (
            <>
              <Elapsed id={entry.toolCallId} />
              <span className="sr-only">in progress</span>
            </>
          ) : (
            <StatusBadge status={entry.status} />
          )}
          {hasBody && <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-2 border-t px-3 py-2">
            {entry.content.length > 0 ? (
              entry.content.map((c, i) => <ToolContentView key={i} content={c} failed={entry.status === "failed"} />)
            ) : (
              <Pre layout="code">{JSON.stringify(entry.rawInput, null, 2)}</Pre>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </CopyMenu>
  );
}

/** The text a tool returned, if any. */
function toolOutput(content: ToolContent[]): string {
  return content.flatMap((c) => (c.type === "content" && c.content.text ? [c.content.text] : [])).join("\n\n");
}

/** The files a tool call touched: its locations and the paths of its diffs. */
function toolPaths(entry: Of<"tool">): string[] {
  const paths = [...entry.locations.map((l) => l.path), ...entry.content.flatMap((c) => (c.type === "diff" ? [c.path] : []))];
  return [...new Set(paths.filter(Boolean))];
}

function ToolContentView({ content, failed }: { content: ToolContent; failed: boolean }) {
  switch (content.type) {
    case "content":
      return content.content.text == null ? <Pre>{`[${content.content.type}]`}</Pre> : <ToolText raw={content.content.text} failed={failed} />;
    case "diff":
      return <TextDiff path={content.path} oldText={content.oldText ?? ""} newText={content.newText} />;
    case "terminal":
      return <ToolTerminal terminalId={content.terminalId} keptOutput={content.keptOutput} exitStatus={content.exitStatus} />;
  }
}

/**
 * A tool's text: a code fence shows as code (no fence markers), a unified diff in the diff view
 * (with the raw text a click away), anything else (messages, errors) wrapped; a failed call's in
 * the destructive colour.
 */
export function ToolText({ raw, failed = false }: { raw: string; failed?: boolean }) {
  const shown = useMemo(() => readToolText(raw), [raw]);
  const [asText, setAsText] = useState(false);
  const layout = toolTextLayout(shown);
  if (layout !== "diff")
    return (
      <Pre layout={layout} failed={failed}>
        {shown.text}
      </Pre>
    );
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-end">
        <Button size="xs" variant="ghost" aria-pressed={asText} onClick={() => setAsText((v) => !v)}>
          {asText ? "Diff view" : "Raw"}
        </Button>
      </div>
      {asText ? <Pre layout="code">{shown.text}</Pre> : <PatchView text={shown.text} />}
    </div>
  );
}

/**
 * A tool's text, as tall as it is up to 24 rem (then it scrolls). Code keeps one line per line and
 * scrolls sideways, tabs 4 wide, with room below the last line for the scrollbar; prose wraps.
 */
function Pre({ children, layout = "prose", failed = false }: { children: string; layout?: "code" | "prose"; failed?: boolean }) {
  return (
    <pre
      data-layout={layout}
      className={cn(
        "max-h-96 rounded-md bg-muted px-2 pt-2 font-mono text-xs leading-5 [tab-size:4]",
        layout === "code" ? "overflow-auto pb-3 whitespace-pre" : "overflow-y-auto pb-2 [overflow-wrap:anywhere] break-words whitespace-pre-wrap",
        failed && "bg-destructive/5 text-destructive",
      )}
    >
      {children}
    </pre>
  );
}

function Plan({ entry }: { entry: Of<"plan"> }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="mb-1 text-xs font-medium text-muted-foreground">Plan</div>
      <ul className="flex flex-col gap-1 text-sm">
        {entry.entries.map((item, i) => (
          <li key={i} className="flex items-start gap-2">
            {item.status === "completed" ? (
              <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="done" />
            ) : item.status === "in_progress" ? (
              <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-label="in progress" />
            ) : (
              <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="to do" />
            )}
            <span className={cn(item.status === "completed" && "text-muted-foreground line-through")}>{item.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const OPTION_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  allow_once: "default",
  allow_always: "secondary",
  reject_once: "outline",
  reject_always: "destructive",
};

/**
 * "Allowed", "Always allowed" or "Auto-allowed" on a tool card whose permission request was
 * allowed: the request itself isn't drawn then. The reason (auto, always) shows beside it when
 * there is room, and in the tooltip.
 */
function AllowedChip({ entry }: { entry: PermissionEntry }) {
  const chip = permissionChip(entry);
  if (!chip) return null;
  const said = chip.reason ? `${chip.label}: ${chip.reason}` : chip.label;
  return (
    <span className="flex min-w-0 shrink items-center gap-1 text-[11px] text-muted-foreground" title={`${said}\n${entry.chosen ?? ""}`.trim()}>
      <ShieldCheck className="size-3 shrink-0" aria-hidden />
      <span className="shrink-0">{chip.label}</span>
      {chip.reason && <span className="hidden truncate @2xl:inline">· {chip.reason}</span>}
      <span className="sr-only">{chip.reason ? `: ${chip.reason}` : ""}</span>
    </span>
  );
}

function Permission({ entry, index, toolInput }: { entry: Of<"permission">; index: number; toolInput?: unknown }) {
  const chat = useChat();
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const pending = entry.chosen == null;
  const respond = (optionId: string) => {
    if (!chat) return;
    setSending(optionId);
    setError(null);
    api
      .respondPermission(chat.sessionId, index, optionId)
      .catch(setError)
      .finally(() => setSending(null));
  };
  const trust = () => {
    if (!chat) return;
    setSending("trust");
    setError(null);
    api
      .trustMcpServer(chat.sessionId, index)
      .catch(setError)
      .finally(() => setSending(null));
  };
  const request = () => (toolInput == null ? entry.title : `${entry.title}\n\n${JSON.stringify(toolInput, null, 2)}`);
  if (!pending) return <AnsweredPermission entry={entry} request={request} />;
  // Trusting answers with the one-off option, so it is offered only when there is one.
  const server = entry.options.some((o) => o.kind === "allow_once") ? entry.mcpServer : undefined;
  const scope = chat?.inProject ? "project" : "chat";
  return (
    <CopyMenu actions={[{ label: "Copy request", text: request }]}>
      <div role="group" aria-label="Permission requested" className="rounded-lg border border-amber-500/60 bg-amber-500/5 px-3 py-2">
        <div className="flex items-start gap-2 text-sm">
          <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Permission requested</div>
            <div className="truncate font-mono text-xs text-muted-foreground" title={entry.title}>
              {entry.title}
            </div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {entry.options.map((o) => (
            <Button
              key={o.optionId}
              size="sm"
              variant={OPTION_VARIANT[o.kind] ?? "outline"}
              disabled={!chat || sending != null}
              onClick={() => respond(o.optionId)}
            >
              {sending === o.optionId && <Loader2 className="animate-spin" />}
              {o.name}
            </Button>
          ))}
        </div>
        {server && (
          <div className="mt-2 flex flex-col items-start gap-0.5 border-t pt-2">
            <Button size="sm" variant="ghost" className="-ml-2" disabled={!chat || sending != null} onClick={trust}>
              {sending === "trust" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              Always allow tools from {server.label} in this {scope}
            </Button>
            <p className="text-xs text-muted-foreground">
              Covers every {server.label} tool, including ones that change things: yaah can&apos;t tell which only read.
            </p>
          </div>
        )}
        <ErrorText error={error} className="mt-1" />
      </div>
    </CopyMenu>
  );
}

/**
 * An answered request drawn on its own, one line: a denial or a cancel (which stay in sight), or an
 * allowed one whose tool call isn't in the transcript. An allowed one with a tool card isn't drawn:
 * the card carries its chip.
 */
function AnsweredPermission({ entry, request }: { entry: Of<"permission">; request: () => string }) {
  const answer = permissionAnswer(entry);
  const chip = permissionChip(entry);
  const what = chip ? chip.label : answer === "cancelled" ? "Cancelled" : answer?.startsWith("reject") ? "Denied" : "Answered";
  const Icon = chip ? ShieldCheck : ShieldX;
  return (
    <CopyMenu actions={[{ label: "Copy request", text: request }]}>
      <div
        role="group"
        aria-label={`Permission ${what.toLowerCase()}`}
        className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs text-muted-foreground"
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 font-medium text-foreground">{what}</span>
        <span className="min-w-0 truncate font-mono" title={entry.title}>
          {entry.title}
        </span>
        <span className="ml-auto shrink-0 truncate" title={entry.chosen ?? undefined}>
          {chip?.reason ?? `→ ${entry.chosen}`}
        </span>
      </div>
    </CopyMenu>
  );
}

function ErrorEntry({ entry, onLogin }: { entry: Of<"error">; onLogin: (accountId: string) => void }) {
  const account = entry.loginAccount;
  return (
    <CopyMenu actions={[{ label: "Copy message", text: () => entry.message }]}>
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <pre className="min-w-0 flex-1 font-sans whitespace-pre-wrap">{entry.message}</pre>
        {account && (
          <Button size="sm" variant="outline" onClick={() => onLogin(account)}>
            <LogIn /> Log in
          </Button>
        )}
      </div>
    </CopyMenu>
  );
}

/** What the agent flagged outside its reply: MCP servers that didn't start or need signing in, and the like. */
function NoticesEntry({ entry }: { entry: Of<"notices"> }) {
  // An MCP server that's fine, only not yaah's ("Codex uses its own fetch"): one quiet line each.
  const infoLines = entry.items.filter((n) => n.mcpServer && n.severity === "info");
  const items = entry.items.filter((n) => !infoLines.includes(n));
  return (
    <>
      {infoLines.map((n, i) => (
        <p key={i} role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0" aria-hidden />
          {n.title}
          {n.description && <span>· {n.description}</span>}
        </p>
      ))}
      {items.length > 0 && <NoticesCard items={items} />}
    </>
  );
}

function NoticesCard({ items }: { items: Of<"notices">["items"] }) {
  const mcp = items.filter((n) => n.mcpServer);
  const warn = items.some((n) => n.severity !== "info");
  const summary =
    mcp.length === items.length
      ? `${mcp.length} MCP ${mcp.length === 1 ? "server isn't" : "servers aren't"} available in this chat`
      : items.length === 1
        ? items[0].title
        : plural(items.length, "notice");
  const problem = (n: (typeof items)[number]) => (n.mcpServer ? n.title.replace(`MCP server "${n.mcpServer}"`, "").trim() : n.title);
  return (
    <CopyMenu
      actions={[{ label: "Copy notices", text: () => items.map((n) => `${n.title}${n.description ? `: ${n.description}` : ""}`).join("\n") }]}
    >
      <div
        role="status"
        className={cn("flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-sm", warn ? "border-amber-500/40 bg-amber-500/5" : "bg-muted/30")}
      >
        <div className="flex items-center gap-2">
          {warn ? (
            <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          ) : (
            <Info className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="font-medium">{summary}</span>
          {mcp.length > 0 && (
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => openSettings("mcp")}>
              MCP servers settings
            </Button>
          )}
        </div>
        <ul className="flex flex-col gap-1 pl-6">
          {items.map((n, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              {n.mcpServer ? (
                <span className="font-mono font-medium text-foreground">{n.mcpServer}</span>
              ) : (
                <span className="font-medium">{n.title}</span>
              )}
              {n.mcpServer && (
                <span className={n.severity === "info" ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400"}>{problem(n)}</span>
              )}
              {n.description && <span className="text-muted-foreground">· {n.description.replace(/ Run \/mcp for the error\.?$/, "")}</span>}
            </li>
          ))}
        </ul>
      </div>
    </CopyMenu>
  );
}

/** The chat moved to another agent: the next message goes to it, with the conversation so far. */
function SwitchEntry({ entry }: { entry: Of<"switch"> }) {
  return (
    <div role="status" aria-label="Agent switched" className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" aria-hidden />
      <Repeat className="size-3 shrink-0" aria-hidden />
      <span className="shrink-0">
        Switched to <span className="font-medium text-foreground">{entry.label}</span>
        {entry.from && <> from {entry.from}</>}
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}

/** Repos added as the chat went: to its project (every chat there gets them) or to this chat only. */
function AddedDirsEntry({ entry }: { entry: Of<"addedDirs"> }) {
  const names = entry.paths.map(baseName);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return (
    <div role="status" aria-label="Repositories added" className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" aria-hidden />
      <FolderPlus className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0" title={entry.paths.join("\n")}>
        Added <span className="font-medium text-foreground">{list}</span> to this {entry.to}
        <span className="block truncate font-mono text-[11px]">{entry.paths.map((p) => compactPath(p)).join(" · ")}</span>
      </span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}
