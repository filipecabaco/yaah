import { useMemo } from "react";
import type { ThemedToken } from "shiki/core";
import type { DiffFile, Line } from "@/components/diff/model";
import { detectLanguage } from "@/lib/language";
import { useTokens } from "@/lib/use-tokens";

/** Tokens for each line of a file's diff: the old side (context + removed) and the new side (context + added) are highlighted as the two texts they are. */
export function useDiffTokens(file: DiffFile): (line: Line) => ThemedToken[] | undefined {
  const sides = useMemo(() => {
    const old: Line[] = [];
    const now: Line[] = [];
    for (const h of file.hunks)
      for (const l of h.lines) {
        if (l.kind !== "+") old.push(l);
        if (l.kind !== "-") now.push(l);
      }
    const text = (ls: Line[]) => ls.map((l) => l.text).join("\n");
    const a = text(old);
    const b = text(now);
    return { old, now, a, b, lang: detectLanguage({ path: file.path, text: b || a }) };
  }, [file]);
  const oldTokens = useTokens(sides.a, sides.lang);
  const newTokens = useTokens(sides.b, sides.lang);
  return useMemo(() => {
    const by = new Map<Line, ThemedToken[]>();
    sides.old.forEach((l, i) => oldTokens?.[i] && by.set(l, oldTokens[i]));
    sides.now.forEach((l, i) => newTokens?.[i] && by.set(l, newTokens[i])); // context lines take the new side
    return (l: Line) => by.get(l);
  }, [sides, oldTokens, newTokens]);
}
