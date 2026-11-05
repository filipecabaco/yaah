// Which language a file's text is in, for syntax highlighting: from its path (extension or a
// well-known file name), else a light look at the text. Always a safe answer: null means "plain".

/** The grammars yaah can load (lib/highlight.ts has a loader for each). */
export const LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "jsonc",
  "rust",
  "elixir",
  "toml",
  "yaml",
  "markdown",
  "bash",
  "css",
  "html",
  "sql",
  "python",
  "go",
  "dockerfile",
  "make",
  "ini",
  "diff",
  "xml",
  "java",
  "c",
  "cpp",
  "ruby",
  "swift",
  "kotlin",
  "php",
  "lua",
] as const;
export type Language = (typeof LANGUAGES)[number];

const EXTENSIONS: Record<string, Language> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  json5: "jsonc",
  rs: "rust",
  ex: "elixir",
  exs: "elixir",
  heex: "elixir",
  toml: "toml",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  css: "css",
  html: "html",
  htm: "html",
  sql: "sql",
  py: "python",
  go: "go",
  mk: "make",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "ini",
  diff: "diff",
  patch: "diff",
  xml: "xml",
  svg: "xml",
  plist: "xml",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  php: "php",
  lua: "lua",
};

/** Whole file names (lower case) whose extension says nothing. */
const FILENAMES: Record<string, Language> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "make",
  gnumakefile: "make",
  "tsconfig.json": "jsonc",
  "jsconfig.json": "jsonc",
  ".babelrc": "jsonc",
  ".eslintrc": "jsonc",
  ".zshrc": "bash",
  ".bashrc": "bash",
  ".bash_profile": "bash",
  ".profile": "bash",
  ".gitignore": "ini",
  ".editorconfig": "ini",
  "cargo.lock": "toml",
  gemfile: "ruby",
  rakefile: "ruby",
  "mix.lock": "elixir",
};

const asLanguage = (id: string): Language | null => ((LANGUAGES as readonly string[]).includes(id) ? (id as Language) : null);

/** The language of a file by its path, or null when unknown. */
export function languageForPath(path: string | null | undefined): Language | null {
  if (!path) return null;
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (!name) return null;
  if (Object.hasOwn(FILENAMES, name)) return FILENAMES[name];
  if (name === ".env" || name.startsWith(".env.")) return "ini";
  if (name.startsWith("dockerfile.")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1);
  return Object.hasOwn(EXTENSIONS, ext) ? EXTENSIONS[ext] : null;
}

/** A fence's info string (`ts`, `rust`, `sh`…) or a path-less hint, as a language; null when unknown. */
export function languageForName(name: string | null | undefined): Language | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (Object.hasOwn(EXTENSIONS, n)) return EXTENSIONS[n];
  if (n === "shell" || n === "console") return null;
  return asLanguage(n);
}

/** A guess from the text alone: a shebang, or JSON. Null when nothing is clear. */
export function sniffLanguage(text: string): Language | null {
  const head = text.slice(0, 2000).trimStart();
  const shebang = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(\w+)/.exec(head);
  if (shebang) {
    const prog = shebang[1];
    if (/^(ba|z|k|da)?sh$/.test(prog)) return "bash";
    if (/^python\d*$/.test(prog)) return "python";
    if (prog === "node" || prog === "deno" || prog === "bun") return "javascript";
    if (prog === "elixir") return "elixir";
    if (prog === "ruby") return "ruby";
    return null;
  }
  if (/^[{[]/.test(head) && text.length <= 200_000) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      return null;
    }
  }
  return null;
}

/** The language for a file's text: its path first, then the hint, then the text itself. */
export function detectLanguage(opts: { path?: string | null; language?: string | null; text: string }): Language | null {
  return languageForName(opts.language) ?? languageForPath(opts.path) ?? sniffLanguage(opts.text);
}

/** Text from a file read: every line has its number in front (`    12→code`, `12<tab>code`), counting up. */
export type Numbered = { start: number; code: string };

export function parseNumbered(text: string): Numbered | null {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) return null;
  const re = /^ *(\d+)(?:\t|→)/;
  const first = re.exec(lines[0]);
  if (!first) return null;
  const start = Number(first[1]);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    // A blank code line may come as the bare number.
    const bare = !m && lines[i].trim() === String(start + i);
    if (!bare && (!m || Number(m[1]) !== start + i)) return null;
    out.push(m ? lines[i].slice(m[0].length) : "");
  }
  return { start, code: out.join("\n") };
}
