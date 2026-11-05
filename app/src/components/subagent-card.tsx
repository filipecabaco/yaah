// A sub-agent drawn as one card: what it is for, whether it is running, how long, what it is doing
// now and how many calls it has made. Closed, it hides those calls and its answer; a permission
// request waiting inside it stays in sight. Which entries belong to it is lib/subagents.ts.
import type { ReactNode } from "react";
import { Bot, Check, ChevronRight, Loader2, ShieldQuestion, X } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { ToolText } from "@/components/entries";
import type { Entry } from "@/lib/api";
import { elapsedText, plural } from "@/lib/format";
import { setGroupOpen, useGroupOpen } from "@/lib/tool-groups";
import {
  agentStatus,
  subagentAnchor,
  latestActivity,
  resultSummary,
  subagentInfo,
  trackSpan,
  useSecondTick,
  type AgentStatus,
} from "@/lib/subagents";
import { cn } from "@/lib/utils";

type Tool = Extract<Entry, { type: "tool" }>;

type Props = {
  /** The chat and the launching call: which card's open state this is. */
  id: string;
  tool: Tool;
  /** The launching call belongs to the turn that is running now. */
  inTurn: boolean;
  /** Its own tool calls, in order. */
  calls: Tool[];
  /** Everything drawn inside it, in order: `waiting` marks a permission request still unanswered. */
  items: { index: number; waiting: boolean }[];
  /** The card for the entry at `index`, as the transcript draws it on its own. */
  card: (index: number) => ReactNode;
  /** Requests of this agent waiting in the transcript's grouped permission card instead of in here. */
  asking?: number;
};

const STATUS_TEXT: Record<AgentStatus, string> = { running: "running", background: "in background", done: "done", failed: "failed" };

function StatusPill({ status }: { status: AgentStatus }) {
  if (status === "done")
    return (
      <Badge variant="outline" className="gap-1">
        <Check className="size-3" /> done
      </Badge>
    );
  if (status === "failed")
    return (
      <Badge variant="destructive" className="gap-1">
        <X className="size-3" /> failed
      </Badge>
    );
  return (
    <Badge variant="secondary" className="gap-1">
      <Loader2 className="size-3 animate-spin" /> {STATUS_TEXT[status]}
    </Badge>
  );
}

export function SubagentCard({ id, tool, inTurn, calls, items, card, asking = 0 }: Props) {
  const info = subagentInfo(tool);
  const status = info ? agentStatus(tool, info, inTurn) : "done";
  const live = status === "running" || status === "background";
  useSecondTick(status === "running");
  const open = useGroupOpen(id);
  if (!info) return null;
  const ms = trackSpan(tool.toolCallId, status === "running");
  const seconds = ms == null ? 0 : Math.floor(ms / 1000);
  const waiting = items.filter((i) => i.waiting);
  const answer = tool.content.flatMap((c) => (c.type === "content" && c.content.text ? [c.content.text] : [])).join("\n\n");
  const summary = status === "done" || status === "failed" ? resultSummary(answer) : null;
  const activity = status === "running" ? latestActivity(calls) : null;
  const hasBody = items.length > 0 || answer.length > 0;
  const meta = [info.type, info.model].filter(Boolean).join(" · ");
  return (
    <Collapsible
      open={open && hasBody}
      onOpenChange={(o) => setGroupOpen(id, o)}
      id={subagentAnchor(tool.toolCallId)}
      data-slot="subagent-card"
      data-status={status}
      className="scroll-mt-4 rounded-lg border bg-card"
    >
      <CollapsibleTrigger disabled={!hasBody} className="group flex w-full flex-col gap-1 px-3 py-2 text-left text-sm">
        <span className="flex w-full items-center gap-2">
          <Bot className={cn("size-4 shrink-0", live ? "text-brand" : "text-muted-foreground")} aria-hidden />
          <span className="min-w-0 flex-1 truncate font-medium" title={info.name}>
            {info.name}
          </span>
          {waiting.length + asking > 0 && (
            <Badge variant="outline" className="gap-1 border-brand text-brand">
              <ShieldQuestion className="size-3" /> needs you
            </Badge>
          )}
          {seconds > 0 && (
            <span
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
              aria-label={`${status === "running" ? "running for" : "took"} ${elapsedText(seconds)}`}
            >
              {elapsedText(seconds)}
            </span>
          )}
          <StatusPill status={status} />
          {hasBody && (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" aria-hidden />
          )}
        </span>
        <span className="flex w-full min-w-0 items-baseline gap-2 pl-6 text-xs text-muted-foreground">
          {meta && <span className="shrink-0">{meta}</span>}
          {calls.length > 0 && <span className="shrink-0">{plural(calls.length, "tool call")}</span>}
          {(activity ?? summary) && <span className="min-w-0 truncate">· {activity ?? summary}</span>}
          {status === "background" && !calls.length && (
            <span className="min-w-0 truncate">· working on its own; its answer comes back as a message</span>
          )}
        </span>
      </CollapsibleTrigger>
      {/* A request waiting inside a closed card is the one thing that must not hide. */}
      {!open && waiting.length > 0 && (
        <div className="flex flex-col gap-3 border-t px-3 py-2">
          {waiting.map((w) => (
            <div key={w.index}>{card(w.index)}</div>
          ))}
        </div>
      )}
      <CollapsibleContent>
        <div className="flex flex-col gap-3 border-t px-3 py-2">
          {items.length > 0 && (
            <div className="flex flex-col gap-3 border-l pl-3">
              {items.map((i) => (
                <div key={i.index}>{card(i.index)}</div>
              ))}
            </div>
          )}
          {answer && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Result</span>
              <ToolText raw={answer} failed={status === "failed"} />
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
