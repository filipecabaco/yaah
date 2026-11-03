// The diff review's data: its files (from git.diff's list and the diff text)
// and what its actions draft into the composer.
import type { useChat } from "@/components/chat-context";
import { hunkRange, parsePatch, type DiffFile, type Hunk } from "@/components/diff/model";
import { hunkText } from "@/components/diff/lines";
import { asArray, asNumber, isObj, type Obj } from "@/lib/narrow";

/** Below this width the file list becomes tabs across the top. */
export const NARROW = 900;

export type Status = DiffFile["status"];
export type ReviewFile = DiffFile & {
  binary: boolean;
  /** In the file list but not in the text (it was cut at the size cap). */
  missing: boolean;
  /** Changes when the file's diff does: a viewed tick holds only for what was viewed. */
  hash: string;
};

export const STATUS: Record<Status, { letter: string; tone: string }> = {
  added: { letter: "A", tone: "text-green-700 dark:text-green-400" },
  modified: { letter: "M", tone: "text-amber-700 dark:text-amber-400" },
  deleted: { letter: "D", tone: "text-red-700 dark:text-red-400" },
  renamed: { letter: "R", tone: "text-blue-700 dark:text-blue-400" },
};
export const isStatus = (s: unknown): s is Status => typeof s === "string" && Object.hasOwn(STATUS, s);

/** FNV-1a over a file's hunks: cheap, and enough to tell "changed since viewed". */
function hashOf(f: DiffFile): string {
  let h = 0x811c9dc5;
  for (const hunk of f.hunks) {
    for (const s of [hunk.header, ...hunk.lines.map((l) => l.kind + l.text)]) {
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
      h = Math.imul(h ^ 10, 0x01000193);
    }
  }
  return `${f.added}.${f.removed}.${(h >>> 0).toString(36)}`;
}

/** The files to review: git.diff's list when given (binary, renamed and cut files too), filled in from the text. */
export function reviewFiles(text: string, meta: unknown): ReviewFile[] {
  const parsed = parsePatch(text);
  const listed = asArray(meta).filter(isObj);
  const withHash = (f: DiffFile, extra: { binary?: boolean; missing?: boolean }): ReviewFile => ({
    ...f,
    binary: !!extra.binary,
    missing: !!extra.missing,
    hash: hashOf(f),
  });
  if (!listed.length) return parsed.map((f) => withHash(f, {}));
  const out: ReviewFile[] = listed.map((m: Obj) => {
    const path = typeof m.path === "string" ? m.path : "";
    const found = parsed.find((f) => f.path === path);
    const status = isStatus(m.status) ? m.status : (found?.status ?? "modified");
    const added = asNumber(m.additions) ?? found?.added ?? 0;
    const removed = asNumber(m.deletions) ?? found?.removed ?? 0;
    const from = typeof m.oldPath === "string" ? m.oldPath : found?.from;
    const binary = m.binary === true;
    const file: DiffFile = found ? { ...found, status, from, added, removed } : { path, from, status, hunks: [], added, removed };
    // A file with changes but no hunks in the text was cut off (renames and binaries have none to show).
    return withHash(file, { binary, missing: !found && !binary && added + removed > 0 });
  });
  for (const f of parsed) if (!out.some((o) => o.path === f.path)) out.push(withHash(f, {}));
  return out;
}

type ChatInfo = NonNullable<ReturnType<typeof useChat>>;

/** The file as the composer mentions it: relative to the chat's folder, and its absolute path. */
function mention(chat: ChatInfo, path: string) {
  const cwd = chat.cwd.replace(/\/$/, "");
  const abs = path.startsWith("/") ? path : `${cwd}/${path}`;
  const label = abs.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1) : abs;
  return { label, path: abs };
}

function lines(hunk: Hunk) {
  const [from, to] = hunkRange(hunk);
  return from === to ? `line ${from}` : `lines ${from}–${to}`;
}

/** What "Ask about this" and "Ask to change or revert this" put in the composer (never sent). */
export function draftFor(chat: ChatInfo, kind: "ask" | "change", file: DiffFile, hunk?: Hunk) {
  const m = mention(chat, file.path);
  const where = hunk ? `@${m.label} ${lines(hunk)}` : `@${m.label}`;
  const block = hunk ? `\n\n\`\`\`diff\n${hunkText(hunk)}\n\`\`\`\n\n` : " ";
  const text = kind === "ask" ? `About ${where}:${block}` : `Please change or revert this in ${where}:${block}`;
  return { text, mention: m };
}
