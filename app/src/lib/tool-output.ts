// What a tool call's text output is, for the card to draw it. Agents wrap command output
// and file reads in a Markdown code fence (Claude's adapter sends "```console\n…\n```",
// with a longer fence when the text holds one); the card shows the code without the fence.
// A unified diff (`git diff`, `diff -u`, `git show`'s patch) is drawn with yaah's diff view.

export type ToolText = {
  /** The text to show: the fence's contents, or the text as it came. */
  text: string;
  /** The fence's language (`console`, `ts`…); null when there was no fence or it named none. */
  lang: string | null;
  fenced: boolean;
  /** `text` is a unified diff. */
  diff: boolean;
};

/** An opening fence of 3+ backticks or tildes, with an optional info string. */
const OPEN = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*\n/;

export function readToolText(raw: string): ToolText {
  const fence = unfence(raw);
  const text = fence?.text ?? raw;
  return { text, lang: fence?.lang ?? null, fenced: fence != null, diff: isUnifiedDiff(text) };
}

/** The contents of a text that is one code fence and nothing else, or null. */
function unfence(raw: string): { text: string; lang: string | null } | null {
  const open = OPEN.exec(raw);
  if (!open) return null;
  const marker = open[1];
  const lines = raw.slice(open[0].length).replace(/\s+$/, "").split("\n");
  // The closing fence: the same character, at least as long, alone on the last line.
  const last = lines[lines.length - 1].trim();
  if (last.length < marker.length || ![...last].every((c) => c === marker[0])) return null;
  return { text: lines.slice(0, -1).join("\n"), lang: open[2] || null };
}

/** Starts with `diff --git`, or with `---`/`+++` file headers (then a hunk). */
export function isUnifiedDiff(text: string): boolean {
  const t = text.replace(/^\s*\n/, "");
  if (/^diff --git /.test(t)) return true;
  return /^--- \S.*\n\+\+\+ \S.*\n@@ /.test(t);
}
