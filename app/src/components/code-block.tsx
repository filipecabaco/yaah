// The one place file text is drawn as code: highlighted by language (from the path, a hint or the
// text), with its line numbers in a gutter that can't be selected, so copying gives the code only.
// Text that is too big, or in a language we don't know, is drawn plain. Never a vertical scroller
// of its own beyond `max-h-96`, as the tool cards always had.
import { memo, useMemo } from "react";
import type { ThemedToken } from "shiki/core";
import { useTokens } from "@/lib/use-tokens";
import { detectLanguage, parseNumbered } from "@/lib/language";
import { cn } from "@/lib/utils";

export type CodeBlockProps = {
  text: string;
  /** The file's path: its extension or name picks the language. */
  path?: string | null;
  /** A language name (a fence's `ts`), which wins over the path. */
  language?: string | null;
  /** Show a gutter of line numbers. Text already numbered by a file read (`12→code`) always gets one. */
  lineNumbers?: boolean;
  /** The number of the first line, for a slice of a file. */
  start?: number;
  /** Read `12→code` / `12<tab>code` prefixes as a file read's line numbers (default). Off for a file's own text. */
  numbered?: boolean;
  failed?: boolean;
  className?: string;
};

export function HighlightedLine({ tokens }: { tokens: ThemedToken[] }) {
  return tokens.map((t, i) => (
    <span key={i} className="hl" style={t.htmlStyle as React.CSSProperties}>
      {t.content}
    </span>
  ));
}

export const CodeBlock = memo(function CodeBlock({
  text,
  path,
  language,
  lineNumbers,
  start,
  numbered: readNumbers = true,
  failed = false,
  className,
}: CodeBlockProps) {
  const numbered = useMemo(() => (readNumbers ? parseNumbered(text) : null), [readNumbers, text]);
  const code = numbered ? numbered.code : text;
  const first = numbered ? numbered.start : (start ?? 1);
  const lang = useMemo(() => detectLanguage({ path, language, text: code }), [path, language, code]);
  const tokens = useTokens(code, lang);
  const gutter = numbered != null || lineNumbers === true;
  const count = useMemo(() => code.split("\n").length, [code]);
  const nums = useMemo(() => (gutter ? Array.from({ length: count }, (_, i) => first + i).join("\n") : ""), [gutter, count, first]);
  const body = tokens
    ? tokens.map((line, i) => (
        <span key={i}>
          {i > 0 && "\n"}
          <HighlightedLine tokens={line} />
        </span>
      ))
    : code;
  return (
    <pre
      data-layout="code"
      data-highlight={tokens ? (lang ?? "") : undefined}
      className={cn(
        "max-h-96 overflow-auto rounded-md bg-muted px-2 pt-2 pb-3 font-mono text-code leading-(--code-row) whitespace-pre [tab-size:4]",
        gutter && "flex",
        failed && "bg-destructive/5 text-destructive",
        className,
      )}
    >
      {gutter ? (
        <>
          <span data-gutter aria-hidden className="sticky left-0 shrink-0 bg-muted pr-3 text-right text-muted-foreground/70 select-none">
            {nums}
          </span>
          <code>{body}</code>
        </>
      ) : (
        body
      )}
    </pre>
  );
});
