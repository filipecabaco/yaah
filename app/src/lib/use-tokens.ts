import { useEffect, useState } from "react";
import type { ThemedToken } from "shiki/core";
import { cachedTokens, canHighlight, highlightTokens } from "@/lib/highlight";
import type { Language } from "@/lib/language";

/** The tokens for `code` in `lang`, null while they are loading, when too big, or when it can't be done. */
export function useTokens(code: string, lang: Language | null): ThemedToken[][] | null {
  const hit = lang ? cachedTokens(code, lang) : undefined;
  const [got, setGot] = useState<{ code: string; lang: Language; tokens: ThemedToken[][] } | null>(null);
  useEffect(() => {
    if (!lang || hit || !canHighlight(code)) return;
    let current = true;
    void highlightTokens(code, lang, () => current).then((tokens) => {
      if (current && tokens) setGot({ code, lang, tokens });
    });
    return () => {
      current = false;
    };
  }, [code, lang, hit]);
  if (hit) return hit;
  return got && got.code === code && got.lang === lang ? got.tokens : null;
}
