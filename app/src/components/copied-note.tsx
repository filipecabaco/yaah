// "Copied" for a moment at the bottom of the window, whenever something is put on the clipboard
// (a Copy button, a menu, copy on select). A polite live region, so it is announced too.
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { onCopied } from "@/lib/clipboard";

export function CopiedNote() {
  const [what, setWhat] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const off = onCopied((w) => {
      setWhat(w);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setWhat(null), 1400);
    });
    return () => {
      off();
      clearTimeout(timer.current);
    };
  }, []);
  return (
    <>
      <p aria-live="polite" className="sr-only">
        {what}
      </p>
      {what && (
        // Only while it shows: nothing fixed stays laid over the window.
        <span
          aria-hidden
          className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-1.5 rounded-md border bg-popover px-2.5 py-1 text-xs text-popover-foreground shadow-md"
        >
          <Check className="size-3.5" /> {what}
        </span>
      )}
    </>
  );
}
