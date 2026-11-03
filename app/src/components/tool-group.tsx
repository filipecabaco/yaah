// A run of tool calls drawn as one quiet row ("7 tool calls · Read, grep, get_issue (linear)"),
// which a click or Enter opens to the cards as they are. What may go in a run is decided in
// lib/tool-groups.ts: never text, rendered UI or a waiting permission request.
import type { ReactNode } from "react";
import { ChevronRight, Layers, Loader2 } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { Entry } from "@/lib/api";
import { plural } from "@/lib/format";
import { groupPreview, setGroupOpen, useGroupOpen } from "@/lib/tool-groups";

type Tool = Extract<Entry, { type: "tool" }>;

type Props = {
  /** The chat and the group's first entry: which group's open state this is. */
  id: string;
  tools: Tool[];
  /** Which of `tools` are still running: they stay in sight under the row, live, open or not. */
  running: boolean[];
  /** How many of their permission requests yaah answered itself (folded chips). */
  autoAllowed: number;
  /** The card for `tools[k]`, as the transcript draws it on its own. */
  card: (k: number) => ReactNode;
};

export function ToolGroup({ id, tools, running, autoAllowed, card }: Props) {
  const open = useGroupOpen(id);
  const failed = tools.filter((t) => t.status === "failed").length;
  const busy = running.some(Boolean);
  const done = tools.map((_, k) => k).filter((k) => !running[k]);
  return (
    <Collapsible open={open} onOpenChange={(o) => setGroupOpen(id, o)} className="flex flex-col gap-3" data-slot="tool-group">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
        <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
        {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden /> : <Layers className="size-3.5 shrink-0" aria-hidden />}
        <span className="shrink-0 font-medium text-foreground">{plural(tools.length, "tool call")}</span>
        <span className="min-w-0 truncate">{groupPreview(tools)}</span>
        {failed > 0 && <span className="shrink-0 text-destructive">· {failed} failed</span>}
        {autoAllowed > 0 && <span className="shrink-0">· {autoAllowed} auto-allowed</span>}
        {busy && <span className="sr-only">, one still running</span>}
      </CollapsibleTrigger>
      {done.length > 0 && (
        <CollapsibleContent className="flex flex-col gap-3">
          {done.map((k) => (
            <div key={k}>{card(k)}</div>
          ))}
        </CollapsibleContent>
      )}
      {tools.map((_, k) => running[k] && <div key={k}>{card(k)}</div>)}
    </Collapsible>
  );
}
