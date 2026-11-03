// An agent's command in its tool card (ACP `terminal` content): its output live,
// read-only, with Stop and "Open as pane". The view is made only while the card is
// open and near the screen (the DOM renderer: cards are many and mostly idle), and
// dropped far off-screen; coming back it attaches again and Rust replays what it
// kept. A released terminal after a restart replays the bytes kept with the tool call.
import { useEffect, useMemo, useRef, useState } from "react";
import { PanelRight, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fromBase64, terminalApi, type TerminalAttached, type TerminalExit } from "@/lib/terminal-api";
import { TerminalView } from "./terminal-view";
import { openTerminalPane } from "./use-terminals";

/** Off-screen by more than this, a card's terminal is disposed. */
const KEEP_MARGIN = "1200px";
const LINE_PX = 14;

export function ToolTerminal({ terminalId, keptOutput, exitStatus }: { terminalId: string; keptOutput?: string; exitStatus?: TerminalExit | null }) {
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(true);
  const [info, setInfo] = useState<TerminalAttached | null>(null);
  const [exit, setExit] = useState<TerminalExit | null>(exitStatus ?? null);
  const [gone, setGone] = useState(false);
  const [stopping, setStopping] = useState(false);
  const replay = useMemo(() => (keptOutput ? fromBase64(keptOutput) : null), [keptOutput]);
  // Keep the card's height while its view is dropped, so scrolling doesn't jump.
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) setHeight(el.offsetHeight || null);
        setNear(e.isIntersecting);
      },
      { rootMargin: KEEP_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const live = info?.live && !exit;
  const rows = Math.min(info?.rows || 24, 24);
  return (
    <div className="flex flex-col gap-1.5" data-tool-terminal={terminalId}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-mono" title={info?.title}>
          {info?.title ?? "Terminal"}
        </span>
        {exit && (
          <Badge variant={exit.exitCode === 0 ? "outline" : "secondary"} className="shrink-0">
            {exit.signal ? `stopped (${exit.signal})` : `exit ${exit.exitCode ?? "?"}`}
          </Badge>
        )}
        {live && (
          <Button
            size="xs"
            variant="outline"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              terminalApi.kill(terminalId).catch((e: unknown) => console.error("could not stop the command", e));
            }}
          >
            <Square /> Stop
          </Button>
        )}
        {(info || replay) && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => openTerminalPane({ cwd: info?.cwd, id: terminalId })}
            title="Show this terminal in a pane of its own"
          >
            <PanelRight /> Open as pane
          </Button>
        )}
      </div>
      <div ref={box} className="overflow-x-auto rounded-md border" style={{ minHeight: near ? undefined : (height ?? rows * LINE_PX) }}>
        {gone ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            This command's output is no longer kept (yaah restarted before the agent finished with it).
          </p>
        ) : (
          near && (
            <TerminalView
              terminalId={terminalId}
              interactive={false}
              renderer="dom"
              fixedSize
              replay={replay}
              scrollback={2000}
              fontSize={11.5}
              className="w-max min-w-full"
              onAttached={(i) => {
                setInfo(i);
                if (i.exit) setExit(i.exit);
              }}
              onExit={setExit}
              onGone={() => setGone(true)}
            />
          )
        )}
      </div>
    </div>
  );
}
