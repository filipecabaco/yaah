// The command-output parsers against real output: the yaah pack's examples
// (src-tauri/components, captured from each tool) and the recorded live_pack run.
import { describe, expect, it } from "vitest";
import testReport from "../../../../src-tauri/components/test-report.json";
import gitGraph from "../../../../src-tauri/components/git-graph.json";
import gitStatus from "../../../../src-tauri/components/git-status.json";
import diffStat from "../../../../src-tauri/components/diff-stat.json";
import wordCount from "../../../../src-tauri/components/word-count.json";
import fileTree from "../../../../src-tauri/components/file-tree.json";
import livePack from "@/dev/fixtures/live-pack.json";
import {
  countFiles,
  parseDiffStat,
  parseGitLog,
  parseGitStatus,
  parseJsonDocs,
  parseTests,
  parseTree,
  parseWc,
  treeFromPaths,
  type FileNode,
} from "./parse";

type Example = { title: string; props: Record<string, unknown> };
const example = (c: { examples: Example[] }, title: string) => {
  const text = c.examples.find((e) => e.title === title)?.props.text;
  if (typeof text !== "string") throw new Error(`no example "${title}"`);
  return text;
};

/** The props a component had when last shown in the recorded live_pack run. */
function lastShown(component: string): Record<string, unknown> {
  let props: Record<string, unknown> | undefined;
  for (const e of livePack as { payload: { entry?: { type: string; component?: string; props?: Record<string, unknown> } } }[])
    if (e.payload.entry?.type === "ui" && e.payload.entry.component === component) props = e.payload.entry.props;
  if (!props) throw new Error(`${component} not in live_pack`);
  return props;
}

const names = (n: FileNode): unknown => (n.dir ? { [n.name]: n.children.map(names) } : n.name);

describe("parseTests", () => {
  it("cargo test with a failure", () => {
    const run = parseTests(example(testReport, "cargo test with a failure"));
    expect(run.tests).toHaveLength(7);
    expect(run.tests.filter((t) => t.status === "pass")).toHaveLength(5);
    expect(run.tests.filter((t) => t.status === "skip").map((t) => t.name)).toEqual(["api::tests::rate_limits"]);
    const failed = run.tests.find((t) => t.status === "fail")!;
    expect(failed.name).toBe("billing::tests::refunds_partial");
    expect(failed.message).toContain("left: 1250");
    expect(run.summary).toEqual({ pass: 5, fail: 1, skip: 1 });
    expect(run.durationMs).toBe(420);
  });

  it("pytest -v, all green", () => {
    const run = parseTests(example(testReport, "pytest -v, all green"));
    expect(run.tests.map((t) => [t.name, t.status])).toEqual([
      ["test_login", "pass"],
      ["test_logout", "pass"],
      ["test_reset_password", "pass"],
      ["test_create_order", "pass"],
      ["test_cancel_order", "skip"],
    ]);
    expect(run.tests[0].file).toBe("tests/test_auth.py");
    expect(run.summary).toEqual({ pass: 4, fail: 0, skip: 1 });
  });

  it("node --test spec output from a recorded run", () => {
    const run = parseTests(String(lastShown("test-report").text));
    expect(run.tests.map((t) => [t.name, t.status])).toEqual([
      ["totals an order", "pass"],
      ["refunds a whole order", "pass"],
      ["refunds part of an order", "fail"],
    ]);
    expect(run.tests[2].message).toContain("4999 == 1499");
    expect(run.summary).toMatchObject({ pass: 2, fail: 1 });
  });

  it("ignores colour codes and carriage-return redraws", () => {
    const run = parseTests("\u001b[32m✔ adds (1ms)\u001b[0m\n\u001b[31m✖ subtracts (2ms)\u001b[0m\nrunning…\r✔ divides (1ms)\n");
    expect(run.tests.map((t) => [t.name, t.status])).toEqual([
      ["adds", "pass"],
      ["subtracts", "fail"],
      ["divides", "pass"],
    ]);
  });
});

describe("file trees", () => {
  const expected = [
    "Cargo.toml",
    "README.md",
    { src: ["main.rs", { api: ["mod.rs", "auth.rs", "orders.rs"] }, { store: ["mod.rs", "migrations.rs"] }] },
    { tests: ["smoke.rs"] },
  ];

  it("tree -F", () => {
    const { root, summary } = parseTree(example(fileTree, "tree -F"));
    expect(root.children.map(names)).toEqual(expected);
    expect(countFiles(root)).toEqual({ files: 9, dirs: 4 });
    expect(summary).toBe("4 directories, 9 files");
  });

  it("GNU tree's UTF-8 guides (│ followed by no-break spaces) keep nested entries", () => {
    const nbsp = example(fileTree, "tree -F").replaceAll("│   ", "│   ");
    expect(nbsp).not.toBe(example(fileTree, "tree -F"));
    expect(parseTree(nbsp).root.children.map(names)).toEqual(expected);
  });

  it("a path list from a recorded `find`", () => {
    const root = treeFromPaths(lastShown("file-tree").paths as string[]);
    expect(countFiles(root).files).toBe(6);
    expect(root.children.map(names)).toEqual(
      expect.arrayContaining([{ src: expect.arrayContaining(["orders.js", { billing: ["refund.js"] }]) as unknown }, { test: ["refund.test.js"] }]),
    );
  });
});

describe("parseGitStatus", () => {
  it("mid-merge with staged work (porcelain v1 -b)", () => {
    const s = parseGitStatus(example(gitStatus, "Mid-merge with staged work"));
    expect(s).toMatchObject({ branch: "feat/refunds", upstream: "origin/feat/refunds", ahead: 2, behind: 0 });
    expect(s.conflicted.map((f) => f.path)).toEqual(["src/api/orders.rs"]);
    expect(s.staged.map((f) => [f.path, f.label])).toEqual([
      ["src/billing.rs", "modified"],
      ["src/billing/refund.rs", "renamed"],
      ["src/billing/partial.rs", "added"],
    ]);
    expect(s.staged[1].from).toBe("src/refund.rs");
    expect(s.unstaged.map((f) => f.path)).toEqual(["README.md"]);
    expect(s.untracked.map((f) => f.path)).toEqual(["notes/refunds.md"]);
  });

  it("a recorded run", () => {
    const s = parseGitStatus(String(lastShown("git-status").text));
    expect(s.branch).toBe("main");
    expect(s.unstaged.map((f) => f.path)).toEqual(["README.md"]);
    expect(s.untracked.map((f) => f.path)).toEqual(["notes.md"]);
  });
});

describe("parseGitLog", () => {
  it("git log --graph over several branches", () => {
    const rows = parseGitLog(example(gitGraph, "All branches"));
    const commits = rows.filter((r) => r.hash);
    expect(commits.map((r) => r.hash)).toEqual(["9f2c1e7", "4b1d0a2", "77e9c3f", "c03f5e1", "1aa8d34", "5e6f7a8", "0b9c8d7", "e4d3c2b"]);
    expect(commits[0]).toMatchObject({ subject: "Merge pull request #48 from feat/refunds", author: "Ada Lovelace", date: "2 hours ago" });
    expect(commits[0].refs).toEqual([
      { name: "HEAD", kind: "head" },
      { name: "main", kind: "branch" },
      { name: "origin/main", kind: "remote" },
    ]);
    // A local branch with a slash next to its remote twin stays local.
    expect(commits[1].refs).toEqual([
      { name: "origin/feat/refunds", kind: "remote" },
      { name: "feat/refunds", kind: "branch" },
    ]);
    expect(commits[5].refs).toEqual([{ name: "origin/spike/cache", kind: "remote" }]);
    expect(commits[4].refs).toEqual([{ name: "v1.4.0", kind: "tag" }]);
    // Connector rows have graph characters but no commit.
    expect(rows.filter((r) => !r.hash).map((r) => r.graph.trim())).toEqual(["|\\", "|/", "|/"]);
  });
});

describe("parseDiffStat", () => {
  it("git diff --stat with a binary file", () => {
    const { files, summary } = parseDiffStat(example(diffStat, "A feature branch"));
    expect(files.map((f) => [f.path, f.added + f.removed])).toEqual([
      ["src/billing.rs", 42],
      ["src/billing/partial.rs", 88],
      ["src/api/orders.rs", 17],
      ["tests/billing_test.rs", 61],
      ["assets/logo.png", 0],
    ]);
    expect(files[4].binary).toContain("4211 bytes");
    expect(summary).toBe("5 files changed, 186 insertions(+), 22 deletions(-)");
  });
});

describe("parseWc", () => {
  it("wc over several files, with the total", () => {
    const rows = parseWc(example(wordCount, "wc over the sources"));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ name: "src/main.rs", counts: [120, 412, 3804], total: false });
    expect(rows.at(-1)).toEqual({ name: "total", counts: [1106, 3705, 36447], total: true });
  });
});

describe("parseJsonDocs", () => {
  it("one document, several (jq), and broken JSON", () => {
    expect(parseJsonDocs('{"a":[1,2]}')).toEqual({ ok: true, value: { a: [1, 2] }, many: false });
    expect(parseJsonDocs('"ord_1042"\n"ord_1043"\n"ord_1050"')).toEqual({ ok: true, value: ["ord_1042", "ord_1043", "ord_1050"], many: true });
    expect(parseJsonDocs('{"a": }').ok).toBe(false);
  });
});
