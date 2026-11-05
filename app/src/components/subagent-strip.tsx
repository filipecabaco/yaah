// "3 agents running · 1 done": a thin strip over the transcript while sub-agents work. Each name
// jumps to its card.
import { Bot } from "lucide-react";
import { stripText, subagentAnchor, type AgentStatus } from "@/lib/subagents";

type Agent = { id: string; name: string; status: AgentStatus };

const MAX_CHIPS = 4;

export function SubagentStrip({ agents }: { agents: Agent[] }) {
  const text = stripText(agents);
  if (!text) return null;
  const running = agents.filter((a) => a.status === "running" || a.status === "background");
  const jump = (id: string) => document.getElementById(subagentAnchor(id))?.scrollIntoView({ block: "center", behavior: "smooth" });
  return (
    <div data-slot="subagent-strip" role="status" className="flex min-h-8 shrink-0 items-center gap-2 border-b bg-background px-3 py-1 text-xs">
      <Bot className="size-3.5 shrink-0 text-brand" aria-hidden />
      <span className="shrink-0 font-medium">{text}</span>
      <span className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {running.slice(0, MAX_CHIPS).map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => jump(a.id)}
            title={`Go to ${a.name}`}
            className="max-w-40 shrink-0 truncate rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {a.name}
          </button>
        ))}
        {running.length > MAX_CHIPS && <span className="shrink-0 text-muted-foreground">+{running.length - MAX_CHIPS}</span>}
      </span>
    </div>
  );
}
