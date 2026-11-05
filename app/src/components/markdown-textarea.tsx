// The message box with its Markdown drawn as you type: headings, emphasis, code, links and
// fences take their colours from the same highlighter as every code view. The real <textarea>
// stays on top with transparent text (caret, selection, IME and undo are all the browser's);
// an aria-hidden copy of the text sits behind it with the colours. Only colours differ, never
// weight, style or size, so both layers wrap identically; the Markdown marks themselves are drawn faint. Until the colours arrive (or for a
// draft too long to colour) the copy is the plain text.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ComponentProps } from "react";
import type { ThemedToken } from "shiki/core";
import { Textarea } from "@/components/ui/textarea";
import { highlightTokens } from "@/lib/highlight";
import { detectLanguage } from "@/lib/language";
import { useTokens } from "@/lib/use-tokens";
import { cn } from "@/lib/utils";

/** A token's colour variables only: a bold or italic heading would be wider than the text typed over it. */
function colour(t: ThemedToken): CSSProperties | undefined {
  const vars = Object.entries(t.htmlStyle ?? {}).filter(([k]) => k.startsWith("--shiki"));
  return vars.length ? Object.fromEntries(vars) : undefined;
}

/** The fenced code blocks of a draft: the line each body starts on, its text and its fence's language. An unclosed fence runs to the end. */
function fences(lines: string[]): { at: number; code: string; lang: string }[] {
  const out: { at: number; code: string; lang: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(```+|~~~+)\s*([\w+#-]*)/.exec(lines[i]);
    if (!open) continue;
    let end = i + 1;
    while (end < lines.length && !lines[end].trimStart().startsWith(open[1])) end++;
    if (end > i + 1) out.push({ at: i + 1, code: lines.slice(i + 1, end).join("\n"), lang: open[2] });
    i = end;
  }
  return out;
}

/** Marks standing alone in a token: emphasis, code ticks, link brackets, a bullet, number or task box. */
const MARK = /^(\*{1,3}|_{1,3}|~~|`{1,3}|~{3,}|\]\(|[[\]()]|[-*+]|\d{1,9}[.)]|\[[ xX]\])$/;
/** A heading, quote or code fence mark at the start of a line, with what follows it. */
const LEAD = /^(\s*(?:#{1,6}[ \t]+|>+[ \t]?|`{3,}|~{3,}))([\s\S]*)$/;
/** A span wrapped in its marks: `**bold**`, `` `code` ``, `~~gone~~`. */
const WRAPPED = /^(\*{1,3}|_{1,3}|~~|`{1,3})([\s\S]+?)\1$/;

/**
 * A token cut into its Markdown marks and its words (the grammar joins them: `**bold**` is one token).
 * The marks stay in the text, so both layers line up, but are drawn faint.
 */
function pieces(toks: ThemedToken[], j: number): { text: string; faint: boolean }[] {
  const raw = toks[j].content;
  const lineStart = toks.slice(0, j).every((x) => !x.content.trim());
  if (MARK.test(raw.trim()) && (lineStart || !/^([-*+]|\d{1,9}[.)]|\[[ xX]\])$/.test(raw.trim()))) return [{ text: raw, faint: true }];
  const lead = lineStart ? LEAD.exec(raw) : null;
  const [mark, rest] = lead ? [lead[1], lead[2]] : ["", raw];
  const wrapped = WRAPPED.exec(rest);
  const out = [
    ...(mark ? [{ text: mark, faint: true }] : []),
    ...(wrapped
      ? [
          { text: wrapped[1], faint: true },
          { text: wrapped[2], faint: false },
          { text: wrapped[1], faint: true },
        ]
      : rest
        ? [{ text: rest, faint: false }]
        : []),
  ];
  return out;
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

  const lines = useMemo(() => value.split("\n"), [value]);
  // Each fence body is coloured in its own language (the Markdown grammar alone leaves it as plain "raw" text).
  const blocks = useMemo(() => fences(lines), [lines]);
  const [embedded, setInner] = useState<Map<number, ThemedToken[]>>(new Map());
  useEffect(() => {
    let current = true;
    void Promise.all(
      blocks.map(async (b) => {
        const lang = detectLanguage({ language: b.lang, text: b.code });
        const toks = lang ? await highlightTokens(b.code, lang, () => current) : null;
        return { b, toks };
      }),
    ).then((done) => {
      if (!current) return;
      const m = new Map<number, ThemedToken[]>();
      for (const { b, toks } of done) toks?.forEach((t, k) => m.set(b.at + k, t));
      setInner(m);
    });
    return () => {
      current = false;
    };
  }, [blocks]);
  return (
    <div className="relative">
      <div aria-hidden data-slot="markdown-overlay" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          ref={inner}
          className={cn("text-base break-words whitespace-pre-wrap text-foreground md:text-sm", overlayClassName)}
          style={{ paddingRight: bar ? `calc(0.75rem + ${bar}px)` : undefined }}
        >
          {lines.map((line, i) => {
            const toks = embedded.get(i) ?? tokens?.[i];
            const same = toks && toks.map((t) => t.content).join("") === line;
            return (
              <span key={i}>
                {i > 0 && "\n"}
                {same
                  ? toks.map((t, j) =>
                      (embedded.has(i) ? [{ text: t.content, faint: false }] : pieces(toks, j)).map((p, k) => (
                        <span key={`${j}.${k}`} className="hl" style={p.faint ? { ...colour(t), opacity: 0.45 } : colour(t)}>
                          {p.text}
                        </span>
                      )),
                    )
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
