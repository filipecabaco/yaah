// A small Copy button: the copy that is always there to click, beside the right-click menu's.
// It turns into a check for a moment, and the live region says so (for screen readers).
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export function CopyButton({ text, label = "Copy", className }: { text: string | (() => string); label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    copyText(typeof text === "function" ? text() : text).then(
      () => {
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1500);
      },
      (e: unknown) => console.error("Copy failed:", e),
    );
  };
  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label={done ? "Copied" : label}
      title={done ? "Copied" : label}
      onClick={copy}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    >
      {done ? <Check /> : <Copy />}
    </Button>
  );
}

/** The hover/focus placement shared by the places that carry one: top-right of a `group/copy` box (a message). */
export const COPY_CORNER =
  "absolute top-1 right-1 z-10 bg-background/80 opacity-0 transition-opacity group-hover/copy:opacity-100 group-focus-within/copy:opacity-100 focus-visible:opacity-100";
/** The same for a code block inside a message: its own group, so a message's hover doesn't light every block. */
export const COPY_CORNER_CODE =
  "absolute top-1 right-1 z-10 bg-background/80 opacity-0 transition-opacity group-hover/code:opacity-100 group-focus-within/code:opacity-100 focus-visible:opacity-100";
