// The message box with its Markdown drawn as you type: headings, emphasis, code, links and
// fences take their colours from the same highlighter as every code view. The real <textarea>
// stays on top with transparent text (caret, selection, IME and undo are all the browser's);
// an aria-hidden copy of the text sits behind it with the colours. Only colours differ, never
// weight, style or size, so both layers wrap identically. Until the colours arrive (or for a
// draft too long to colour) the copy is the plain text.
import { useLayoutEffect, useRef, useState, type CSSProperties, type ComponentProps } from "react";
import type { ThemedToken } from "shiki/core";
import { Textarea } from "@/components/ui/textarea";
import { useTokens } from "@/lib/use-tokens";
import { cn } from "@/lib/utils";

/** A token's colour variables only: a bold or italic heading would be wider than the text typed over it. */
function colour(t: ThemedToken): CSSProperties | undefined {
  const vars = Object.entries(t.htmlStyle ?? {}).filter(([k]) => k.startsWith("--shiki"));
  return vars.length ? Object.fromEntries(vars) : undefined;
}

export function MarkdownTextarea({
  value,
  className,
  overlayClassName,
  ref,
  onScroll,
  ...props
}: Omit<ComponentProps<typeof Textarea>, "value"> & { value: string; overlayClassName?: string }) {
  const fresh = useTokens(value, "markdown");
  // Keep the last colours while the next ones are made, used line by line where the line is unchanged.
  const [last, setLast] = useState<ThemedToken[][] | null>(null);
  if (fresh && fresh !== last) setLast(fresh);
  const tokens = fresh ?? last;

  const own = useRef<HTMLTextAreaElement | null>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState(0);
  // Follow the textarea's scroll, and leave room for its scrollbar so lines wrap at the same place.
  const sync = () => {
    const el = own.current;
    if (!el) return;
    if (inner.current) inner.current.style.transform = `translateY(${-el.scrollTop}px)`;
    setBar((b) => (b === el.offsetWidth - el.clientWidth ? b : el.offsetWidth - el.clientWidth));
  };
  useLayoutEffect(sync, [value]);

  const lines = value.split("\n");
  return (
    <div className="relative">
      <div aria-hidden data-slot="markdown-overlay" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          ref={inner}
          className={cn("text-base break-words whitespace-pre-wrap text-foreground md:text-sm", overlayClassName)}
          style={{ paddingRight: bar ? `calc(0.75rem + ${bar}px)` : undefined }}
        >
          {lines.map((line, i) => {
            const toks = tokens?.[i];
            const same = toks && toks.map((t) => t.content).join("") === line;
            return (
              <span key={i}>
                {i > 0 && "\n"}
                {same
                  ? toks.map((t, j) => (
                      <span key={j} className="hl" style={colour(t)}>
                        {t.content}
                      </span>
                    ))
                  : line}
              </span>
            );
          })}
          {/* A trailing newline needs its empty last line to keep the height the textarea has. */}
          {"​"}
        </div>
      </div>
      <Textarea
        {...props}
        value={value}
        ref={(el) => {
          own.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        onScroll={(e) => {
          sync();
          onScroll?.(e);
        }}
        className={cn("relative text-transparent caret-foreground", className)}
      />
    </div>
  );
}
