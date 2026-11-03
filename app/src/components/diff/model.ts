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

type Op = "=" | "-" | "+";

/** Diff two texts by lines (Myers), grouped into hunks with 3 lines of context. */
export function diffTexts(path: string, oldText: string, newText: string): DiffFile {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText ? newText.split("\n") : [];
  if (a.at(-1) === "") a.pop();
  if (b.at(-1) === "") b.pop();

  const lines: Line[] = [];
  let o = 1;
  let n = 1;
  for (const op of diffLines(a, b)) {
    if (op === "=") lines.push({ kind: " ", text: a[o - 1], old: o++, new: n++ });
    else if (op === "-") lines.push({ kind: "-", text: a[o - 1], old: o++ });
    else lines.push({ kind: "+", text: b[n - 1], new: n++ });
  }
  const added = lines.filter((l) => l.kind === "+").length;
  const removed = lines.filter((l) => l.kind === "-").length;
  return { path, status: a.length === 0 ? "added" : "modified", hunks: toHunks(lines), added, removed };
}

/**
 * The shortest edit script from `a` to `b`, line by line: Myers' O(ND) algorithm in linear
 * space (the middle snake, divide and conquer), so it is exact for files of any size and
 * fast when they're similar. Lines are compared as numbers (each distinct line gets one).
 * Within each run of changes, removals come before additions.
 */
export function diffLines(a: string[], b: string[]): Op[] {
  const ids = new Map<string, number>();
  const intern = (lines: string[]) => Int32Array.from(lines, (l) => ids.get(l) ?? (ids.set(l, ids.size), ids.size - 1));
  const x = intern(a);
  const y = intern(b);
  const ops: Op[] = [];
  myers(x, 0, x.length, y, 0, y.length, ops);
  // Removals first in each change: the order a reader expects.
  for (let i = 0; i < ops.length;) {
    if (ops[i] === "=") {
      i++;
      continue;
    }
    let j = i;
    let removed = 0;
    while (j < ops.length && ops[j] !== "=") if (ops[j++] === "-") removed++;
    for (let k = i; k < j; k++) ops[k] = k - i < removed ? "-" : "+";
    i = j;
  }
  return ops;
}

function myers(a: Int32Array, aLo: number, aHi: number, b: Int32Array, bLo: number, bHi: number, ops: Op[]) {
  // The common start and end are kept as they are.
  let pre = 0;
  while (aLo + pre < aHi && bLo + pre < bHi && a[aLo + pre] === b[bLo + pre]) pre++;
  let suf = 0;
  while (aHi - suf > aLo + pre && bHi - suf > bLo + pre && a[aHi - 1 - suf] === b[bHi - 1 - suf]) suf++;
  for (let k = 0; k < pre; k++) ops.push("=");
  aLo += pre;
  bLo += pre;
  aHi -= suf;
  bHi -= suf;
  const n = aHi - aLo;
  const m = bHi - bLo;
  if (n === 0) for (let k = 0; k < m; k++) ops.push("+");
  else if (m === 0) for (let k = 0; k < n; k++) ops.push("-");
  else {
    const split = middleSnake(a, aLo, n, b, bLo, m);
    if (split) {
      myers(a, aLo, aLo + split[0], b, bLo, bLo + split[1], ops);
      myers(a, aLo + split[0], aHi, b, bLo + split[1], bHi, ops);
    } else {
      // Nothing in common.
      for (let k = 0; k < n; k++) ops.push("-");
      for (let k = 0; k < m; k++) ops.push("+");
    }
  }
  for (let k = 0; k < suf; k++) ops.push("=");
}

/**
 * Where the forward and backward searches for the shortest path meet: the point
 * (x, y) on it to split the problem at, or null when the ranges share nothing.
 * Both ranges are non-empty and differ at their first and last lines.
 */
function middleSnake(a: Int32Array, aLo: number, n: number, b: Int32Array, bLo: number, m: number): [number, number] | null {
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD;
  const size = 2 * maxD + 2;
  const vf = new Int32Array(size).fill(-1);
  const vb = new Int32Array(size).fill(-1);
  vf[offset + 1] = 0;
  vb[offset + 1] = 0;
  const delta = n - m;
  // With an odd delta the paths meet on a forward step, with an even one on a backward step.
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const i1 = offset + k1;
      let x1 = k1 === -d || (k1 !== d && vf[i1 - 1] < vf[i1 + 1]) ? vf[i1 + 1] : vf[i1 - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
        x1++;
        y1++;
      }
      vf[i1] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const i2 = offset + delta - k1;
        if (i2 >= 0 && i2 < size && vb[i2] !== -1 && x1 >= n - vb[i2]) return [x1, y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const i2 = offset + k2;
      let x2 = k2 === -d || (k2 !== d && vb[i2 - 1] < vb[i2 + 1]) ? vb[i2 + 1] : vb[i2 - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aLo + n - x2 - 1] === b[bLo + m - y2 - 1]) {
        x2++;
        y2++;
      }
      vb[i2] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const i1 = offset + delta - k2;
        if (i1 >= 0 && i1 < size && vf[i1] !== -1) {
          const x1 = vf[i1];
          const y1 = offset + x1 - i1;
          if (x1 >= n - x2) return [x1, y1];
        }
      }
    }
  }
  return null;
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
