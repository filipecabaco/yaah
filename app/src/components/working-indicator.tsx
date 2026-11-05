// "✱ Working… (2m 44s · ↓ 8.9k tokens · thought for 1s)": the one live line at the end of a running
// transcript, so it is plain that work is happening. One per chat (each pane has its own); the
// per-tool timers inside cards are separate. Tokens and thinking time show only when given: the
// agent protocol yaah speaks carries neither today, so they are never estimated.
import { useEffect, useState } from "react";
import { shortCount, turnClock } from "@/lib/working";

type Props = {
  /** What it is doing: "Working…", "Thinking…", a tool's label, "Waiting for your answer". */
  phase: string;
  /** Epoch ms the turn began. */
  since: number;
  /** Sub-agents still running, as the strip over the transcript counts them. */
  agents?: number;
  /** Output tokens this turn, only when the agent reports them. */
  tokens?: number;
  /** Seconds spent thinking, only when the agent reports it. */
  thoughtSeconds?: number;
};

export function WorkingIndicator({ phase, since, agents = 0, tokens, thoughtSeconds }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const details = [
    turnClock((now - since) / 1000),
    tokens != null && `↓ ${shortCount(tokens)} tokens`,
    thoughtSeconds != null && `thought for ${turnClock(thoughtSeconds)}`,
  ].filter(Boolean);
  return (
    <div data-slot="working-indicator" className="flex items-baseline gap-2 text-sm text-muted-foreground">
      <span aria-hidden className="inline-block w-4 shrink-0 animate-pulse text-center text-brand motion-reduce:animate-none">
        ✱
      </span>
      {/* Announced once, politely, when the phase changes; the ticking time below is never read out. */}
      <span role="status" aria-live="polite" className="min-w-0 truncate">
        {phase}
        {agents > 0 && ` · ${agents} ${agents === 1 ? "agent" : "agents"} running`}
      </span>
      <span aria-live="off" className="shrink-0 text-xs tabular-nums">
        ({details.join(" · ")})
      </span>
    </div>
  );
}
