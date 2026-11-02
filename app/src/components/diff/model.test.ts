import { describe, expect, it } from "vitest";
import liveShowcase from "@/dev/fixtures/live-showcase.json";
import { changed, diffTexts, hunkRange, parsePatch } from "@/components/diff/model";

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
