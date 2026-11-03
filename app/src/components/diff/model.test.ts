import { describe, expect, it } from "vitest";
import liveShowcase from "@/dev/fixtures/live-showcase.json";
import { changed, diffLines, diffTexts, hunkRange, parsePatch } from "@/components/diff/model";

/** The `git add -N . && git diff` the agent showed in the recorded live_showcase run. */
function recordedDiff(): string {
  let diff: unknown;
  for (const e of liveShowcase as { payload: { entry?: { type: string; props?: { diff?: unknown } } } }[])
    if (e.payload.entry?.type === "ui" && e.payload.entry.props?.diff) diff = e.payload.entry.props.diff;
  if (typeof diff !== "string") throw new Error("no diff in live_showcase");
  return diff;
}

describe("parsePatch", () => {
  it("a new file from a recorded git diff", () => {
    const [file, ...rest] = parsePatch(recordedDiff());
    expect(rest).toHaveLength(0);
    expect(file).toMatchObject({ path: "index.html", status: "added", removed: 0, added: 294 });
    expect(file.hunks).toHaveLength(1);
    expect(file.hunks[0].lines[0]).toEqual({ kind: "+", text: "<!DOCTYPE html>", new: 1 });
    expect(file.hunks[0].lines.at(-1)?.new).toBe(294);
  });

  it("several files, renames, and content that looks like headers", () => {
    const patch = [
      "diff --git a/db/schema.sql b/db/schema.sql",
      "index 1111111..2222222 100644",
      "--- a/db/schema.sql",
      "+++ b/db/schema.sql",
      "@@ -1,3 +1,3 @@",
      " CREATE TABLE orders (",
      "--- old comment",
      "+++ new comment",
      " );",
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 90%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -10,2 +10,2 @@ export function f() {",
      "-  return 1;",
      "+  return 2;",
      "   }",
      "",
    ].join("\n");
    const files = parsePatch(patch);
    expect(files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ["db/schema.sql", "modified", 1, 1],
      ["src/new.ts", "renamed", 1, 1],
    ]);
    // A removed SQL comment `-- old comment` is content, not a `---` header.
    expect(files[0].hunks[0].lines.map((l) => l.kind + l.text)).toEqual([" CREATE TABLE orders (", "--- old comment", "+++ new comment", " );"]);
    expect(files[1].from).toBe("src/old.ts");
    expect(files[1].hunks[0].lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ["-", 10, undefined],
      ["+", undefined, 10],
      [" ", 11, 11],
    ]);
    expect(changed(files)).toBe(4);
  });

  it("plain diff -u with timestamps and two files", () => {
    const patch = [
      "--- a.txt\t2026-10-01 10:00:00.000000000 +0200",
      "+++ a.txt\t2026-10-02 10:00:00.000000000 +0200",
      "@@ -1 +1 @@",
      "-one",
      "+uno",
      "--- b.txt\t2026-10-01 10:00:00.000000000 +0200",
      "+++ b.txt\t2026-10-02 10:00:00.000000000 +0200",
      "@@ -1 +1,2 @@",
      " two",
      "+dos",
    ].join("\n");
    expect(parsePatch(patch).map((f) => [f.path, f.added, f.removed])).toEqual([
      ["a.txt", 1, 1],
      ["b.txt", 1, 0],
    ]);
  });

  it("text that isn't a diff gives no files", () => {
    expect(parsePatch("hello\nworld")).toEqual([]);
    expect(parsePatch("")).toEqual([]);
  });
});

describe("diffTexts", () => {
  it("a small edit in a large file is exact and numbered", () => {
    const before = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`);
    const after = [...before];
    after[999] = "line 1000, changed";
    const file = diffTexts("/abs/big.txt", before.join("\n"), after.join("\n"));
    expect(file).toMatchObject({ path: "/abs/big.txt", status: "modified", added: 1, removed: 1 });
    const lines = file.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== " ");
    expect(lines).toEqual([
      { kind: "-", text: "line 1000", old: 1000 },
      { kind: "+", text: "line 1000, changed", new: 1000 },
    ]);
  });

  it("a new file (no old text) is all additions", () => {
    const file = diffTexts("hello.txt", "", "hi from yaah\n");
    expect(file).toMatchObject({ status: "added", added: 1, removed: 0 });
  });

  it("identical texts have no hunks", () => {
    expect(diffTexts("x", "a\nb", "a\nb").hunks).toEqual([]);
  });
});

describe("hunkRange", () => {
  it("covers the changed lines, or the context when a preview cut the changes off", () => {
    const [hunk] = parsePatch("--- a/x\n+++ b/x\n@@ -5,3 +5,3 @@\n a\n-b\n+B\n c\n")[0].hunks;
    expect(hunkRange(hunk)).toEqual([6, 6]);
    const contextOnly = { header: "@@", lines: [{ kind: " " as const, text: "a", old: 5, new: 7 }] };
    expect(hunkRange(contextOnly).every(Number.isFinite)).toBe(true);
  });
});

/** Length of the longest common subsequence (the classic table), as a reference for Myers. */
function lcsLength(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  return prev[b.length];
}

/** Applying the edit script to `a` must give `b`. */
function apply(a: string[], b: string[], ops: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  for (const op of ops) {
    if (op === "=") {
      expect(a[i]).toBe(b[j]);
      out.push(a[i++]);
      j++;
    } else if (op === "-") i++;
    else out.push(b[j++]);
  }
  expect([i, j]).toEqual([a.length, b.length]);
  return out;
}

/** A small deterministic generator, so a failure always reproduces. */
function rng(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

describe("diffLines (Myers)", () => {
  it.each([
    ["abcabba", "cbabac", 5], // the paper's example: D = 5
    ["", "abc", 3],
    ["abc", "", 3],
    ["abc", "abc", 0],
    ["abc", "xyz", 6],
    ["a", "b", 2],
    ["ab", "ba", 2],
  ])("%s → %s takes %i edits and rebuilds the new text", (from, to, d) => {
    const a = [...from];
    const b = [...to];
    const ops = diffLines(a, b);
    expect(apply(a, b, ops)).toEqual(b);
    expect(ops.filter((o) => o !== "=").length).toBe(d);
  });

  it("is minimal on random texts (as many edits as the LCS allows)", () => {
    const next = rng(42);
    for (let round = 0; round < 300; round++) {
      const pick = () => Array.from({ length: Math.floor(next() * 40) }, () => "abcde"[Math.floor(next() * 5)]);
      const a = pick();
      const b = pick();
      const ops = diffLines(a, b);
      expect(apply(a, b, ops)).toEqual(b);
      expect(ops.filter((o) => o !== "=").length).toBe(a.length + b.length - 2 * lcsLength(a, b));
    }
  });

  it("puts each change's removals before its additions", () => {
    const ops = diffLines(["a", "x", "b"], ["a", "y", "b"]);
    expect(ops).toEqual(["=", "-", "+", "="]);
  });
});

describe("diffTexts on large files", () => {
  it("a 5000-line file with every 7th line changed is exact, not a whole-file replace", () => {
    const before = Array.from({ length: 5000 }, (_, i) => `const line${i} = compute(${i});`);
    const after = before.map((l, i) => (i % 7 === 0 ? `${l} // changed` : l));
    const t0 = performance.now();
    const file = diffTexts("big.ts", before.join("\n"), after.join("\n"));
    const ms = performance.now() - t0;
    const changedLines = Math.ceil(5000 / 7);
    expect(file).toMatchObject({ status: "modified", added: changedLines, removed: changedLines });
    // Every change is the one line, removed then added, at its own number.
    const changes = file.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== " ");
    expect(changes.slice(0, 4)).toEqual([
      { kind: "-", text: "const line0 = compute(0);", old: 1 },
      { kind: "+", text: "const line0 = compute(0); // changed", new: 1 },
      { kind: "-", text: "const line7 = compute(7);", old: 8 },
      { kind: "+", text: "const line7 = compute(7); // changed", new: 8 },
    ]);
    // Changes 7 lines apart share their context, so it's one hunk of every line.
    expect(file.hunks).toHaveLength(1);
    expect(ms).toBeLessThan(2000);
  });

  it("two unrelated 5000-line files are all removed and all added", () => {
    const a = Array.from({ length: 5000 }, (_, i) => `old ${i}`).join("\n");
    const b = Array.from({ length: 5000 }, (_, i) => `new ${i}`).join("\n");
    expect(diffTexts("x", a, b)).toMatchObject({ added: 5000, removed: 5000 });
  });

  it("scattered inserts and deletes in 5000 lines line up with the right line numbers", () => {
    const before = Array.from({ length: 5000 }, (_, i) => `row ${i}`);
    const after = before.filter((_, i) => i % 500 !== 3);
    after.splice(2500, 0, "inserted A", "inserted B");
    const file = diffTexts("x", before.join("\n"), after.join("\n"));
    expect(file).toMatchObject({ added: 2, removed: 10 });
    const lines = file.hunks.flatMap((h) => h.lines);
    expect(lines.filter((l) => l.kind === "-").map((l) => l.old)).toEqual([4, 504, 1004, 1504, 2004, 2504, 3004, 3504, 4004, 4504]);
    expect(lines.filter((l) => l.kind === "+").map((l) => [l.text, l.new])).toEqual([
      ["inserted A", 2501],
      ["inserted B", 2502],
    ]);
  });
});
