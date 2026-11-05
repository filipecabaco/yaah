// Syntax highlighting with Shiki (the same family as the colour themes in lib/theme.ts). The
// engine, the two code themes and each grammar load on first use, so the app's first paint
// never pays for them. Colours come out as CSS variables (`--shiki-light` / `--shiki-dark`), so a
// token follows the app's light/dark mode with no re-highlight (index.css picks one).
import type { HighlighterCore, ThemedToken } from "shiki/core";
import { Lru } from "@/lib/lru";
import type { Language } from "@/lib/language";

/** Above these a text is shown plain: highlighting is for reading, not for log dumps. */
export const MAX_HIGHLIGHT_BYTES = 200_000;
export const MAX_HIGHLIGHT_LINES = 5000;
/** Lines tokenized per slice, with the main thread freed in between. */
const CHUNK_LINES = 400;

export function canHighlight(text: string): boolean {
  if (text.length > MAX_HIGHLIGHT_BYTES) return false;
  let lines = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) if (++lines > MAX_HIGHLIGHT_LINES) return false;
  return true;
}

const GRAMMARS: Record<Language, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
};

let core: Promise<HighlighterCore> | null = null;
const loaded = new Map<Language, Promise<void>>();

function engine(): Promise<HighlighterCore> {
  core ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    async ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      }),
  );
  return core;
}

async function grammar(hl: HighlighterCore, lang: Language): Promise<void> {
  let p = loaded.get(lang);
  if (!p) {
    p = GRAMMARS[lang]().then((mod) => hl.loadLanguage((mod as { default: never }).default));
    loaded.set(lang, p);
    p.catch(() => loaded.delete(lang));
  }
  return p;
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/** Tokens already made, by language and text (a card reopened or re-rendered costs nothing). */
const done = new Lru<string, ThemedToken[][]>(200);

/** The tokens in cache for this text, if it was highlighted before. */
export function cachedTokens(code: string, lang: Language): ThemedToken[][] | undefined {
  return done.get(`${lang}\0${code}`);
}

/**
 * One array of tokens per line, or null when the text is too big or the grammar can't load. The work
 * runs in slices of a few hundred lines, handing the thread back between them.
 */
export async function highlightTokens(code: string, lang: Language, isCurrent: () => boolean = () => true): Promise<ThemedToken[][] | null> {
  if (!canHighlight(code)) return null;
  const hit = cachedTokens(code, lang);
  if (hit) return hit;
  try {
    const hl = await engine();
    await grammar(hl, lang);
    const lines = code.split("\n");
    const out: ThemedToken[][] = [];
    let state;
    for (let i = 0; i < lines.length; i += CHUNK_LINES) {
      if (!isCurrent()) return null;
      const res = hl.codeToTokens(lines.slice(i, i + CHUNK_LINES).join("\n"), {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: false,
        grammarState: state,
      });
      out.push(...res.tokens);
      state = hl.getLastGrammarState(res.tokens);
      if (i + CHUNK_LINES < lines.length) await yieldToUi();
    }
    done.set(`${lang}\0${code}`, out);
    return out;
  } catch (e) {
    console.error("could not highlight", e);
    return null;
  }
}
