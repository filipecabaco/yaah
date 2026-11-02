// One model for every diff in the app: files → hunks → numbered lines.
// Built from `git diff` output (agent-built UI) or from old/new text (tool calls).

export type Line = { kind: " " | "+" | "-"; text: string; old?: number; new?: number };
export type Hunk = { header: string; lines: Line[] };
export type DiffFile = {
  /** Path as the diff names it (relative for git, absolute for tool calls). */
  path: string;
  from?: string;
  status: "added" | "deleted" | "modified" | "renamed";
  hunks: Hunk[];
  added: number;
  removed: number;
};

export const changed = (files: DiffFile[]) => files.reduce((n, f) => n + f.added + f.removed, 0);

/** Parse unified diff text (`git diff`, `diff -u`) into files and numbered hunks. */
export function parsePatch(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  // Lines still to come in the current hunk, from its header. While any are
  // left, a line is content even if it looks like a header ("--- x" is a
  // removed "-- x", e.g. an SQL comment).
  let oldLeft = 0;
  let newLeft = 0;
  const open = (path = ""): DiffFile => {
    const f: DiffFile = { path, status: "modified", hunks: [], added: 0, removed: 0 };
    files.push(f);
    hunk = undefined;
    return f;
  };
  const lines = text.split("\n");
  // The final newline doesn't start another line.
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (file && hunk && (oldLeft > 0 || newLeft > 0) && !line.startsWith("@@") && !line.startsWith("diff ")) {
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      const at = hunk.lines;
      if (line.startsWith("+")) {
        file.added++;
        newLeft--;
        at.push({ kind: "+", text: line.slice(1), new: newNo++ });
      } else if (line.startsWith("-")) {
        file.removed++;
        oldLeft--;
        at.push({ kind: "-", text: line.slice(1), old: oldNo++ });
      } else {
        // Context; an empty line is context whose leading space was trimmed.
        oldLeft--;
        newLeft--;
        at.push({ kind: " ", text: line.slice(1), old: oldNo++, new: newNo++ });
      }
    } else if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = open(m?.[2]);
      file.from = m?.[1];
    } else if (line.startsWith("new file mode")) {
      if (file) file.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      if (file) file.status = "deleted";
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      // Without `diff --git` lines (plain `diff -u`), each "---" starts the next file.
      if (!file || (line.startsWith("--- ") && file.hunks.length)) file = open();
      const name = line
        .slice(4)
        .split("\t")[0]
        .replace(/^[ab]\//, "")
        .trim();
      if (name === "/dev/null") file.status = line.startsWith("---") ? "added" : "deleted";
      else if (line.startsWith("--- ")) file.from = name;
      else file.path = name;
    } else if (line.startsWith("@@") && file) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/.exec(line);
      oldNo = Number(m?.[1] ?? 1);
      newNo = Number(m?.[3] ?? 1);
      // A header without counts (hand-written) takes every line up to the next header.
      oldLeft = m ? Number(m[2] ?? 1) : Infinity;
      newLeft = m ? Number(m[4] ?? 1) : Infinity;
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    }
  }
  for (const f of files) if (f.status === "modified" && f.from && f.from !== f.path) f.status = "renamed";
  return files.filter((f) => f.hunks.length);
}

const CONTEXT = 3;
/** Above this many cells the LCS table gets expensive; fall back to a coarser diff. */
const MAX_CELLS = 4_000_000;

type Op = "=" | "-" | "+";
const repeat = (op: Op, n: number): Op[] => Array<Op>(n).fill(op);

/** Diff two texts by lines (LCS), grouped into hunks with 3 lines of context. */
export function diffTexts(path: string, oldText: string, newText: string): DiffFile {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText ? newText.split("\n") : [];
  if (a.at(-1) === "") a.pop();
  if (b.at(-1) === "") b.pop();

  const lines: Line[] = [];
  let o = 1;
  let n = 1;
  for (const op of lineOps(a, b)) {
    if (op === "=") lines.push({ kind: " ", text: a[o - 1], old: o++, new: n++ });
    else if (op === "-") lines.push({ kind: "-", text: a[o - 1], old: o++ });
    else lines.push({ kind: "+", text: b[n - 1], new: n++ });
  }
  const added = lines.filter((l) => l.kind === "+").length;
  const removed = lines.filter((l) => l.kind === "-").length;
  return { path, status: a.length === 0 ? "added" : "modified", hunks: toHunks(lines), added, removed };
}

/**
 * The common start and end are kept as is; only the middle is diffed (LCS), so
 * a small edit to a big file stays cheap. A middle too big for the LCS table is
 * shown as replaced.
 */
function lineOps(a: string[], b: string[]): Op[] {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const midA = a.slice(s, a.length - e);
  const midB = b.slice(s, b.length - e);
  const mid = midA.length * midB.length > MAX_CELLS ? [...repeat("-", midA.length), ...repeat("+", midB.length)] : lcs(midA, midB);
  return [...repeat("=", s), ...mid, ...repeat("=", e)];
}

function lcs(a: string[], b: string[]): Op[] {
  const w = b.length + 1;
  const t = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push("=");
      i++;
      j++;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) {
      ops.push("-");
      i++;
    } else {
      ops.push("+");
      j++;
    }
  }
  while (i++ < a.length) ops.push("-");
  while (j++ < b.length) ops.push("+");
  return ops;
}

function toHunks(lines: Line[]): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i].kind === " ") i++;
    if (i >= lines.length) break;
    const from = Math.max(0, i - CONTEXT);
    let end = i;
    // Extend while the next change is within 2×context of this one.
    for (let k = i; k < lines.length; k++) {
      if (lines[k].kind !== " ") end = k;
      else if (k - end > CONTEXT * 2) break;
    }
    const to = Math.min(lines.length, end + CONTEXT + 1);
    const slice = lines.slice(from, to);
    const o = slice.find((l) => l.old)?.old ?? 0;
    const n = slice.find((l) => l.new)?.new ?? 0;
    const oc = slice.filter((l) => l.kind !== "+").length;
    const nc = slice.filter((l) => l.kind !== "-").length;
    hunks.push({ header: `@@ -${o},${oc} +${n},${nc} @@`, lines: slice });
    i = to;
  }
  return hunks;
}

/** Line range a hunk touches in the new file (or old, for pure deletions); all of it when only context is shown. */
export function hunkRange(h: Hunk): [number, number] {
  const changes = h.lines.filter((l) => l.kind !== " ");
  let lo = Infinity;
  let hi = 0;
  for (const l of changes.length ? changes : h.lines) {
    const n = l.new ?? l.old ?? 0;
    lo = Math.min(lo, n);
    hi = Math.max(hi, n);
  }
  return [lo === Infinity ? 0 : lo, hi];
}
