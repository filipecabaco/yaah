// One component per kind of transcript entry. Rust owns the transcript; these
// only draw it. Every entry is memoised on the entry object itself (Rust sends
// a new object only for the entry that changed), so a streaming reply
// re-renders one entry, not the whole chat.
import { memo, useMemo, useState } from "react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  FilePen,
  FileText,
  Globe,
  Info,
  LayoutPanelTop,
  Loader2,
  LogIn,
  Paperclip,
  Pencil,
  Quote,
  Search,
  ShieldQuestion,
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
import { TextDiff, UiTree } from "@/components/ui-render";
import type { FormHost } from "@/components/ui-form-host";
import { api, type Entry, type ToolContent } from "@/lib/api";
import { openComponent, openSettings } from "@/lib/app-events";
import { plural } from "@/lib/format";
import { cardKey, cardKeyLabel, cardMode, saveCardRule, useCardRules, type CardMode } from "@/lib/tool-cards";
import { cn } from "@/lib/utils";
import { uiToolLabel } from "@/lib/ui-tool-label";

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
  onLogin: (accountId: string) => void;
};

/** One transcript entry. Re-renders only when its own entry or position in the turn changes. */
export const TranscriptEntry = memo(function TranscriptEntry({ entry, index, inTurn, live, toolInput, onLogin }: EntryProps) {
  switch (entry.type) {
    case "user":
      return <UserMessage entry={entry} />;
    case "agent":
      return <AgentMessage entry={entry} />;
    case "thought":
      return <Thought entry={entry} live={live} />;
    case "tool":
      return <ToolCall entry={entry} turnActive={inTurn} />;
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
  return (
    <div className="flex flex-col items-end gap-1">
      <CopyMenu
        act={() => [{ label: "Edit as new message", icon: <Pencil />, onSelect: () => draftIntoComposer({ text: entry.text }) }]}
        actions={[{ label: "Copy text", text: () => entry.text }]}
      >
        <div className="max-w-[80%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{entry.text}</div>
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

function AgentMessage({ entry }: { entry: Of<"agent"> }) {
  return (
    <CopyMenu
      // The selected part of this message, if any; else all of it.
      act={(t) => [{ label: "Quote in reply", icon: <Quote />, onSelect: () => draftIntoComposer({ text: quoted(t.ownSelection || entry.text) }) }]}
      actions={[{ label: "Copy text", text: () => entry.text }]}
    >
      <div className="text-sm">
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
        <div className="mt-1 border-l-2 pl-3 text-xs whitespace-pre-wrap text-muted-foreground">{entry.text}</div>
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

/** MCP tools arrive as `mcp__<server>__<tool>`; yaah's own UI tools get plain names. */
const UI_TOOL_TITLES: Record<string, string> = {
  ui_catalog: "Read the UI catalog",
  ui_get_component: "Read a UI component",
  ui_render: "Rendered UI",
  ui_save_component: "Saved a UI component",
};

function toolTitle(title: string): string {
  const m = /^mcp__([^_]+(?:-[^_]+)*)__(.+)$/.exec(title);
  if (!m) return title;
  const [, server, tool] = m;
  return server === "yaah-ui" && UI_TOOL_TITLES[tool] ? UI_TOOL_TITLES[tool] : `${server} › ${tool}`;
}

const RULE_ACTIONS: { mode: CardMode; label: (like: string) => string; icon: typeof Wrench }[] = [
  { mode: "collapsed", label: (like) => `Always collapse “${like}”`, icon: ChevronRight },
  { mode: "expanded", label: (like) => `Always expand “${like}”`, icon: ChevronDown },
  { mode: "auto", label: (like) => `Open “${like}” only while it runs`, icon: Wrench },
];

/** A tool call. How its card opens is a rule per kind of tool (Settings → Chat): `auto` opens it while its turn runs. */
function ToolCall({ entry, turnActive }: { entry: Of<"tool">; turnActive: boolean }) {
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
  const ui = uiToolLabel(entry.title, entry.status, entry.rawInput);
  const hasBody = entry.content.length > 0 || entry.rawInput != null;
  const copyActions = [{ label: "Copy title", text: () => entry.title }];
  if (entry.rawInput != null) copyActions.push({ label: "Copy input", text: () => JSON.stringify(entry.rawInput, null, 2) });
  const output = toolOutput(entry.content);
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
          {ui?.busy ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-brand" aria-hidden />
          ) : (
            <Icon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className={cn("min-w-0 flex-1 truncate text-xs", !ui && "font-mono")} title={entry.title}>
            {ui ? ui.text : toolTitle(entry.title)}
          </span>
          {ui?.busy ? <span className="sr-only">in progress</span> : <StatusBadge status={entry.status} />}
          {hasBody && <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-2 border-t px-3 py-2">
            {entry.content.length > 0 ? (
              entry.content.map((c, i) => <ToolContentView key={i} content={c} />)
            ) : (
              <Pre>{JSON.stringify(entry.rawInput, null, 2)}</Pre>
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

function ToolContentView({ content }: { content: ToolContent }) {
  switch (content.type) {
    case "content":
      return <Pre>{content.content.text ?? `[${content.content.type}]`}</Pre>;
    case "diff":
      return <TextDiff path={content.path} oldText={content.oldText ?? ""} newText={content.newText} />;
    case "terminal":
      return <p className="text-xs text-muted-foreground">Terminal output isn't shown in this PoC.</p>;
  }
}

function Pre({ children }: { children: string }) {
  return <pre className="max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-xs break-all whitespace-pre-wrap">{children}</pre>;
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
  const request = () => (toolInput == null ? entry.title : `${entry.title}\n\n${JSON.stringify(toolInput, null, 2)}`);
  return (
    <CopyMenu actions={[{ label: "Copy request", text: request }]}>
      <div
        role="group"
        aria-label="Permission requested"
        className={cn("rounded-lg border px-3 py-2", pending && "border-amber-500/60 bg-amber-500/5")}
      >
        <div className="flex items-start gap-2 text-sm">
          <ShieldQuestion className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Permission requested</div>
            <div className="truncate font-mono text-xs text-muted-foreground" title={entry.title}>
              {entry.title}
            </div>
          </div>
        </div>
        {pending ? (
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
        ) : (
          <div className="mt-1 text-xs text-muted-foreground">→ {entry.chosen}</div>
        )}
        <ErrorText error={error} className="mt-1" />
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
  const items = entry.items;
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

function UiEntry({ entry, index }: { entry: Of<"ui">; index: number }) {
  const sessionId = useChat()?.sessionId;
  // Forms in this UI answer through its transcript entry (and a waiting ui_ask, if any),
  // and share their draft with the agent (ui_get_values / ui_set_values).
  const form = useMemo<FormHost>(
    () => ({
      answer: entry.answer,
      asking: !!entry.askId,
      draft: entry.draft,
      draftBy: entry.draftBy,
      onSubmit: sessionId ? (values) => api.answerUi(sessionId, index, values) : undefined,
      onEdit: sessionId ? (values) => api.editUi(sessionId, index, values).then(() => undefined) : undefined,
    }),
    [entry.answer, entry.askId, entry.draft, entry.draftBy, sessionId, index],
  );
  return (
    <CopyMenu
      act={() => {
        const name = entry.component;
        return name ? [{ label: "Open in Component library", icon: <LayoutPanelTop />, onSelect: () => openComponent(name) }] : [];
      }}
      actions={[
        { label: "Copy UI JSON", text: () => JSON.stringify(entry.tree, null, 2) },
        { label: "Copy props JSON", text: () => JSON.stringify(entry.props, null, 2) },
      ]}
    >
      <figure className="flex flex-col gap-1.5">
        <figcaption className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <LayoutPanelTop className="size-3" />
          {entry.title ?? (entry.component ? null : "UI")}
          {entry.askId && entry.answer == null && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
              waiting for you
            </Badge>
          )}
          {entry.component && entry.version != null && (
            <Badge variant="outline" className="h-4 px-1 font-mono text-[10px]">
              {entry.component} v{entry.version}
            </Badge>
          )}
        </figcaption>
        <UiTree tree={entry.tree} props={entry.props} form={form} />
      </figure>
    </CopyMenu>
  );
}
