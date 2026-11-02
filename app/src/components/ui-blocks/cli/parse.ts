// Parsers for command output the agent passes as printed (test runs, tree, wc,
// git). Pure functions from text to display data: no state, no I/O. When a
// line isn't recognised it is kept, never dropped, so nothing the command
// printed goes missing from the view.

import { errorMessage } from "@/lib/narrow";

// ── tests ───────────────────────────────────────────────────────────────────

export type TestStatus = "pass" | "fail" | "skip";
export type TestCase = { name: string; status: TestStatus; file?: string; duration?: number; message?: string };
export type TestRun = {
  tests: TestCase[];
  /** Totals from the runner's summary line, when it printed one. */
  summary?: { pass: number; fail: number; skip: number };
  durationMs?: number;
};

// Built from a string so the escape character isn't a control character inside a regex literal.
const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`, "g");
const stripAnsi = (s: string) => s.replace(ANSI, "");

/** Lines as a terminal shows them: a carriage return redraws the line. */
function screenLines(raw: string): string[] {
  return stripAnsi(raw)
    .split("\n")
    .map((l) => l.replace(/\r$/, "").split("\r").pop()!);
}

function ms(value: string, unit: string): number {
  const n = parseFloat(value);
  return unit.startsWith("µ") || unit === "us" ? n / 1000 : unit === "s" || unit === "sec" ? n * 1000 : n;
}

export function parseTests(raw: string): TestRun {
  const lines = screenLines(raw);
  const tests: TestCase[] = [];
  const byName = new Map<string, TestCase>();
  const add = (t: TestCase) => {
    const prev = byName.get(t.name);
    if (prev) {
      // Seen in the list and again in a failure summary: keep one, merge details.
      Object.assign(prev, { ...t, message: t.message ?? prev.message, file: t.file ?? prev.file, duration: t.duration ?? prev.duration });
      return;
    }
    tests.push(t);
    byName.set(t.name, t);
  };
  let summary: TestRun["summary"];
  let durationMs: number | undefined;

  // Failure detail blocks, keyed by test name, attached at the end.
  const details = new Map<string, string[]>();
  let detailFor: string | null = null;
  const goRun: string[] = [];
  let inFailures = false;
  let yaml = false;
  const nodeSummary: Record<string, number> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;

    // cargo: "test path::name ... ok" / FAILED / ignored
    if ((m = line.match(/^test (\S+) \.\.\. (ok|FAILED|ignored|failed)(?:, .*)?$/))) {
      add({ name: m[1], status: m[2] === "ok" ? "pass" : m[2] === "ignored" ? "skip" : "fail" });
      continue;
    }
    // cargo failure output: "---- path::name stdout ----"
    if ((m = line.match(/^---- (\S+) std(?:out|err) ----$/))) {
      detailFor = m[1];
      details.set(detailFor, []);
      continue;
    }
    if ((m = line.match(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored.*?(?:finished in ([\d.]+)s)?$/))) {
      const s = { pass: +m[1], fail: +m[2], skip: +m[3] };
      summary = summary ? { pass: summary.pass + s.pass, fail: summary.fail + s.fail, skip: summary.skip + s.skip } : s;
      if (m[4]) durationMs = (durationMs ?? 0) + parseFloat(m[4]) * 1000;
      detailFor = null;
      continue;
    }
    if (detailFor && /^(failures:|successes:)$/.test(line.trim())) {
      detailFor = null;
      continue;
    }

    // go: "=== RUN TestX", "--- FAIL: TestX (0.00s)"
    if (/^=== RUN\s+\S/.test(line)) {
      goRun.length = 0;
      detailFor = null;
      continue;
    }
    if ((m = line.match(/^\s*--- (PASS|FAIL|SKIP): (\S+) \(([\d.]+)s\)/))) {
      add({
        name: m[2],
        status: m[1] === "PASS" ? "pass" : m[1] === "SKIP" ? "skip" : "fail",
        duration: parseFloat(m[3]) * 1000,
        message: m[1] === "FAIL" && goRun.length ? goRun.join("\n") : undefined,
      });
      goRun.length = 0;
      continue;
    }
    if (/^\s{4}\S/.test(line) && !detailFor && /\.go:\d+:/.test(line)) {
      goRun.push(line.trim());
      continue;
    }

    // pytest -v: "tests/test_x.py::test_y PASSED [ 10%]"
    if ((m = line.match(/^(\S+?)::(\S+(?:\[.*?\])?) (PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)\b/))) {
      add({
        name: m[2],
        file: m[1],
        status: m[3] === "PASSED" || m[3] === "XPASS" ? "pass" : m[3] === "SKIPPED" || m[3] === "XFAIL" ? "skip" : "fail",
      });
      continue;
    }
    // pytest short summary: "FAILED tests/test_x.py::test_y - AssertionError: …"
    if ((m = line.match(/^(FAILED|ERROR) (\S+?)::(\S+)(?: - (.*))?$/))) {
      add({ name: m[3], file: m[2], status: "fail", message: m[4] });
      continue;
    }
    // pytest failure header: "_____ test_y _____"
    if ((m = line.match(/^_{3,} (\S.*?) _{3,}$/))) {
      detailFor = m[1].replace(/^\S+?::/, "").replace(/^Test\w+\./, "");
      details.set(detailFor, []);
      continue;
    }
    if ((m = line.match(/^=+ (.*?) in ([\d.]+)s(?: \(.*\))? =+$/))) {
      const count = (word: string) => +(m![1].match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
      summary = { pass: count("passed") + count("xpassed"), fail: count("failed") + count("errors?"), skip: count("skipped") + count("xfailed") };
      durationMs = parseFloat(m[2]) * 1000;
      detailFor = null;
      continue;
    }

    // node --test (spec) repeats failures under "✖ failing tests:" with their errors.
    if (/^\s*✖ failing tests:\s*$/.test(line)) {
      inFailures = true;
      detailFor = null;
      continue;
    }
    if (inFailures && /^test at \S+$/.test(line.trim())) continue;
    // node --test summary: "ℹ pass 2"
    if ((m = line.match(/^ℹ (tests|pass|fail|skipped|todo|duration_ms) ([\d.]+)$/))) {
      nodeSummary[m[1]] = parseFloat(m[2]);
      continue;
    }
    // jest / vitest / node --test (spec): "✓ name (5 ms)", "✕ name", "× name", "○ skipped name", "↓ name", "﹣ name # SKIP"
    if (
      (m = line.match(/^\s*(✓|✔|√|✕|✖|×|○|↓|﹣|-)\s+(.+?)(?:\s+\(?([\d.]+)\s?(ms|s|µs)\)?)?(\s+#\s*(?:SKIP|TODO)\b.*)?$/)) &&
      (m[1] !== "-" || /^\s{2,}-\s/.test(line))
    ) {
      const s = m[1];
      const status: TestStatus = m[5] || "○↓﹣-".includes(s) ? "skip" : "✓✔√".includes(s) ? "pass" : "fail";
      const name = m[2].replace(/^skipped\s+/, "");
      add({ name, status, duration: m[3] ? ms(m[3], m[4]) : undefined });
      if (inFailures && status === "fail") {
        detailFor = name;
        details.set(name, []);
      }
      continue;
    }
    // jest failure header: "  ● Suite › name"
    if ((m = line.match(/^\s*● (.+?)(?: › (.+))?$/))) {
      detailFor = (m[2] ?? m[1]).trim();
      details.set(detailFor, []);
      continue;
    }
    if ((m = line.match(/^\s*Tests:\s+(.*)$/))) {
      const count = (word: string) => +(m![1].match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
      summary = { pass: count("passed"), fail: count("failed"), skip: count("skipped") + count("todo") };
      detailFor = null;
      continue;
    }
    // TAP: "ok 1 - name", "not ok 2 - name # SKIP"
    if ((m = line.match(/^\s*(not ok|ok) \d+(?: -)? (.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/))) {
      const status: TestStatus = m[3] ? "skip" : m[1] === "ok" ? "pass" : "fail";
      add({ name: m[2], status });
      // The YAML block after a failure holds the error.
      detailFor = status === "fail" ? m[2] : null;
      if (detailFor) details.set(detailFor, []);
      continue;
    }
    if (detailFor && /^\s*(---|\.\.\.)$/.test(line)) {
      yaml = line.trim() === "---";
      if (!yaml) detailFor = null;
      continue;
    }
    if (yaml && detailFor && /^\s+(duration_ms|type|failureType|location|code|name|operator|stack): /.test(line) && byName.get(detailFor)) {
      if (/^\s+stack: /.test(line)) detailFor = null;
      continue;
    }
    if ((m = line.match(/^# (tests|pass|fail|skip|skipped|todo|duration_ms) ([\d.]+)$/))) {
      nodeSummary[m[1] === "skip" ? "skipped" : m[1]] = parseFloat(m[2]);
      continue;
    }
    if (/^(# Subtest: |TAP version|1\.\.\d+$)/.test(line)) continue;

    // mix test --trace: "  * test adds (0.1ms) [L#12]", "  * test slow (skipped) [L#6]"; failures: "  1) test adds (MathTest)"
    if ((m = line.match(/^\s+\* (test .+?) \((?:([\d.]+)(ms|s)|(skipped|excluded|invalid))\)(?: \[L#\d+\])?$/))) {
      add({ name: m[1], status: m[4] ? "skip" : "pass", duration: m[2] ? ms(m[2], m[3]) : undefined });
      continue;
    }
    // mix test (1.17+): "Result: 1/2 passed, 1 skipped"
    if ((m = line.match(/^Result: (\d+)\/(\d+) passed(?:, (\d+) (?:skipped|excluded))?/))) {
      summary = { pass: +m[1], fail: +m[2] - +m[1], skip: +(m[3] ?? 0) };
      detailFor = null;
      continue;
    }
    if (/^(Failed: \d+ tests?|Finished in .* seconds|Running ExUnit with seed)/.test(line)) {
      detailFor = null;
      continue;
    }
    if ((m = line.match(/^\s+\d+\) (test .+?) \((\S+)\)$/))) {
      detailFor = m[1];
      add({ name: m[1], file: m[2], status: "fail" });
      details.set(detailFor, []);
      continue;
    }
    if ((m = line.match(/^(\d+) (?:tests?|doctests?)(?:, (\d+) doctests?)?, (\d+) failures?(?:, (\d+) (?:skipped|excluded|invalid))?/))) {
      const total = +m[1];
      summary = { pass: total - +m[3] - +(m[4] ?? 0), fail: +m[3], skip: +(m[4] ?? 0) };
      detailFor = null;
      continue;
    }
    // rspec: "12 examples, 1 failure, 2 pending"
    if ((m = line.match(/^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/))) {
      summary = { pass: +m[1] - +m[2] - +(m[3] ?? 0), fail: +m[2], skip: +(m[3] ?? 0) };
      continue;
    }

    if (detailFor) details.get(detailFor)!.push(line);
  }

  if (nodeSummary.pass != null && !summary)
    summary = { pass: nodeSummary.pass, fail: nodeSummary.fail ?? 0, skip: (nodeSummary.skipped ?? 0) + (nodeSummary.todo ?? 0) };
  if (nodeSummary.duration_ms != null) durationMs ??= nodeSummary.duration_ms;

  for (const [name, body] of details) {
    const text = trimBlock(body);
    if (!text) continue;
    const t = byName.get(name) ?? tests.find((t) => t.status === "fail" && (name.endsWith(t.name) || t.name.endsWith(name)));
    if (t) t.message = t.message && t.message.length > text.length ? t.message : text;
    else add({ name, status: "fail", message: text });
  }
  return { tests, summary, durationMs };
}

function trimBlock(lines: string[]): string {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  const kept = lines.slice(a, b);
  const indent = Math.min(...kept.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  return kept.map((l) => l.slice(indent)).join("\n");
}

// ── tree ────────────────────────────────────────────────────────────────────

export type FileNode = { name: string; dir: boolean; children: FileNode[] };

/** Output of `tree` (unicode or `-A`/ASCII, with or without `-F`). Its UTF-8 guide is "│" + two no-break spaces + a space. */
export function parseTree(raw: string): { root: FileNode; summary?: string } {
  const lines = stripAnsi(raw)
    .split(/\r?\n/)
    .filter((l) => l.trim());
  let summary: string | undefined;
  if (lines.length && /^\d+ director(y|ies)(, \d+ files?)?$/.test(lines[lines.length - 1].trim())) summary = lines.pop()!.trim();
  const rootName = lines.length && !/[├└|`]/.test(lines[0]) ? lines.shift()!.trim() : ".";
  const root: FileNode = { name: rootName, dir: true, children: [] };
  const stack: FileNode[] = [root];
  for (const line of lines) {
    const m = line.match(/^((?:[│|][ \u00a0]{2,3}|[ \u00a0]{4}|\u00a0{1,2} {1,2})*)(?:[├└][─]{2}|[|`]--) (.*)$/);
    if (!m) continue;
    const depth = Math.round(m[1].length / 4) + 1;
    let name = m[2];
    const dir = name.endsWith("/");
    name = name.replace(/[/*=@|]$/, "").replace(/ -> .*$/, "");
    const node: FileNode = { name, dir, children: [] };
    stack.length = Math.min(stack.length, depth);
    const parent = stack[stack.length - 1] ?? root;
    parent.dir = true;
    parent.children.push(node);
    stack.push(node);
  }
  return { root, summary };
}

/** A flat list of paths (find, git ls-files, rg --files). */
export function treeFromPaths(paths: string[]): FileNode {
  const root: FileNode = { name: ".", dir: true, children: [] };
  for (const raw of paths) {
    const parts = raw.trim().replace(/^\.\//, "").split("/").filter(Boolean);
    if (!parts.length) continue;
    let at = root;
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      let next = at.children.find((c) => c.name === part);
      if (!next) {
        next = { name: part, dir: !last || raw.endsWith("/"), children: [] };
        at.children.push(next);
      }
      if (!last) next.dir = true;
      at = next;
    });
  }
  // A single top folder (e.g. every path starts with src/) becomes the root.
  return root.children.length === 1 && root.children[0].dir ? root.children[0] : root;
}

export function countFiles(n: FileNode): { files: number; dirs: number } {
  let files = 0;
  let dirs = 0;
  for (const c of n.children) {
    if (c.dir) {
      dirs++;
      const sub = countFiles(c);
      files += sub.files;
      dirs += sub.dirs;
    } else files++;
  }
  return { files, dirs };
}

// ── json ────────────────────────────────────────────────────────────────────

/** JSON text, or several documents in a row (jq prints one per result). */
export function parseJsonDocs(raw: string): { ok: true; value: unknown; many: boolean } | { ok: false; error: string } {
  const text = raw.trim();
  try {
    return { ok: true, value: JSON.parse(text), many: false };
  } catch (first) {
    // jq prints one document per result: split them and show a list.
    const docs: unknown[] = [];
    for (let i = skipWs(text, 0); i < text.length; i = skipWs(text, i)) {
      const end = valueEnd(text, i);
      try {
        docs.push(JSON.parse(text.slice(i, end)));
      } catch {
        return { ok: false, error: errorMessage(first) };
      }
      i = end;
    }
    return docs.length > 1 ? { ok: true, value: docs, many: true } : { ok: false, error: errorMessage(first) };
  }
}

function skipWs(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** End (exclusive) of the JSON value starting at `i`, by brackets and strings. */
function valueEnd(text: string, i: number): number {
  if (text[i] === '"') {
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "\\") j++;
      else if (text[j] === '"') return j + 1;
    }
    return text.length;
  }
  if (text[i] !== "{" && text[i] !== "[") return i + (text.slice(i).match(/^\S+/)?.[0].length ?? 1);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === '"') j = valueEnd(text, j) - 1;
    else if (ch === "{" || ch === "[") depth++;
    else if ((ch === "}" || ch === "]") && --depth === 0) return j + 1;
  }
  return text.length;
}

// ── wc ──────────────────────────────────────────────────────────────────────

export type WcRow = { name: string; counts: number[]; total: boolean };

export function parseWc(raw: string): WcRow[] {
  return stripAnsi(raw)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => {
      const m = l.match(/^((?:\d+\s+)*\d+)(?:\s+(.+))?$/);
      if (!m) return [];
      const name = m[2] ?? "";
      return [{ name, counts: m[1].split(/\s+/).map(Number), total: name === "total" }];
    });
}

// ── git ─────────────────────────────────────────────────────────────────────

export type GitRef = { name: string; kind: "head" | "branch" | "remote" | "tag" };
export type GitRow = {
  /** The graph characters before the commit, e.g. "| * " or "|/ ". */
  graph: string;
  hash?: string;
  refs: GitRef[];
  subject?: string;
  author?: string;
  date?: string;
};

export function parseGitLog(raw: string): GitRow[] {
  const rows: GitRow[] = stripAnsi(raw)
    .split(/\r?\n/)
    .filter((l) => l.length)
    .map((line) => {
      const m = line.match(/^([*|\\/ _.-]*?)([0-9a-f]{7,40})\b ?(.*)$/);
      if (!m || (!m[1].includes("*") && m[1].trim())) {
        // A graph-only connector row ("|\  ", "| |/") or a line we don't know.
        return /^[*|\\/ _.-]+$/.test(line) ? { graph: line, refs: [] } : { graph: "", refs: [], subject: line };
      }
      let rest = m[3];
      const refs: GitRef[] = [];
      const deco = rest.match(/^\((.*?)\)\s?/);
      if (deco) {
        rest = rest.slice(deco[0].length);
        for (const part of deco[1].split(/,\s*/)) {
          if (part.startsWith("HEAD -> ")) {
            refs.push({ name: "HEAD", kind: "head" }, { name: part.slice(8), kind: "branch" });
          } else if (part === "HEAD") refs.push({ name: "HEAD", kind: "head" });
          else if (part.startsWith("tag: ")) refs.push({ name: part.slice(5), kind: "tag" });
          // `remote/branch` or a local `feat/x`: told apart once every ref is known (below).
          else refs.push({ name: part, kind: "branch" });
        }
      }
      let author: string | undefined;
      let date: string | undefined;
      const tail = rest.match(/\s\(([^(),]+), ([^(),]+ ago|\d{4}-\d{2}-\d{2}[^()]*)\)$/);
      if (tail) {
        author = tail[1];
        date = tail[2];
        rest = rest.slice(0, tail.index);
      }
      return { graph: m[1], hash: m[2], refs, subject: rest, author, date };
    });
  markRemotes(rows.flatMap((r) => r.refs));
  return rows;
}

/**
 * Without --decorate=full, `origin/main` and a local `feat/refunds` look alike.
 * A prefix is a remote when it's `origin`/`upstream`, or when `prefix/x` sits
 * next to a local `x` somewhere in the log (`origin/feat/refunds, feat/refunds`).
 */
function markRemotes(refs: GitRef[]) {
  const branches = refs.filter((r) => r.kind === "branch");
  const names = new Set(branches.map((r) => r.name));
  const remotes = new Set(["origin", "upstream"]);
  for (const { name } of branches) {
    const slash = name.indexOf("/");
    if (slash > 0 && names.has(name.slice(slash + 1))) remotes.add(name.slice(0, slash));
  }
  for (const r of branches) {
    const slash = r.name.indexOf("/");
    if (slash > 0 && remotes.has(r.name.slice(0, slash))) r.kind = "remote";
  }
}

export type GitFile = { path: string; from?: string; code: string; label: string };
export type GitStatus = {
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  conflicted: GitFile[];
  staged: GitFile[];
  unstaged: GitFile[];
  untracked: GitFile[];
  other: string[];
};

const CHANGE: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type changed",
  U: "conflict",
  "?": "untracked",
};

export function parseGitStatus(raw: string): GitStatus {
  const s: GitStatus = { ahead: 0, behind: 0, conflicted: [], staged: [], unstaged: [], untracked: [], other: [] };
  const lines = stripAnsi(raw)
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const porcelain = lines.every((l) => /^(## |[ MADRCTU?!]{2} )/.test(l));
  if (porcelain) {
    for (const l of lines) {
      if (l.startsWith("## ")) {
        const m = l.slice(3).match(/^(?:No commits yet on )?(\S+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/);
        if (m) {
          s.branch = m[1];
          s.upstream = m[2];
          s.ahead = +(m[3]?.match(/ahead (\d+)/)?.[1] ?? 0);
          s.behind = +(m[3]?.match(/behind (\d+)/)?.[1] ?? 0);
        }
        continue;
      }
      const [x, y] = [l[0], l[1]];
      let path = l.slice(3);
      let from: string | undefined;
      if (path.includes(" -> ")) [from, path] = path.split(" -> ");
      if (x === "?") s.untracked.push({ path, code: "?", label: "untracked" });
      else if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D"))
        s.conflicted.push({ path, code: "U", label: "conflict" });
      else {
        if (x !== " " && x !== "!") s.staged.push({ path, from, code: x, label: CHANGE[x] ?? x });
        if (y !== " " && y !== "!") s.unstaged.push({ path, code: y, label: CHANGE[y] ?? y });
      }
    }
    return s;
  }
  // Long form `git status`.
  let section: keyof Pick<GitStatus, "staged" | "unstaged" | "untracked" | "conflicted"> | null = null;
  for (const l of lines) {
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^On branch (\S+)/))) s.branch = m[1];
    else if ((m = l.match(/^Your branch is (ahead|behind) of '(.+?)' by (\d+) commits?/))) {
      s.upstream = m[2];
      s[m[1] as "ahead" | "behind"] = +m[3];
    } else if ((m = l.match(/^Your branch and '(.+?)' have diverged/))) s.upstream = m[1];
    else if ((m = l.match(/^and have (\d+) and (\d+) different commits/))) [s.ahead, s.behind] = [+m[1], +m[2]];
    else if ((m = l.match(/^Your branch is up to date with '(.+?)'/))) s.upstream = m[1];
    else if (/^Changes to be committed/.test(l)) section = "staged";
    else if (/^Changes not staged/.test(l)) section = "unstaged";
    else if (/^Untracked files/.test(l)) section = "untracked";
    else if (/^Unmerged paths/.test(l)) section = "conflicted";
    else if (/^\s+\(use "git/.test(l)) continue;
    else if (
      section &&
      (m = l.match(
        /^\s+(new file|modified|deleted|renamed|copied|typechange|both modified|both added|both deleted|deleted by us|deleted by them|added by us|added by them):\s+(.*)$/,
      ))
    ) {
      let path = m[2];
      let from: string | undefined;
      if (path.includes(" -> ")) [from, path] = path.split(" -> ");
      const label = m[1] === "new file" ? "added" : m[1] === "typechange" ? "type changed" : m[1];
      const code = { added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C", "type changed": "T" }[label] ?? "U";
      s[section].push({ path, from, code, label });
    } else if (section === "untracked" && /^\s+\S/.test(l)) s.untracked.push({ path: l.trim(), code: "?", label: "untracked" });
    else if (!/^(nothing|no changes)/.test(l)) s.other.push(l.trim());
  }
  return s;
}

export type StatRow = { path: string; added: number; removed: number; binary?: string };

/** `git diff --stat`: "path | 12 ++++--"; counts come from the summary when bars are scaled. */
export function parseDiffStat(raw: string): { files: StatRow[]; summary?: string } {
  const files: StatRow[] = [];
  let summary: string | undefined;
  for (const line of stripAnsi(raw).split(/\r?\n/)) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*(.+?)\s+\|\s+(\d+) ?(\+*)(-*)\s*$/))) {
      const n = parseFloat(m[2]);
      const plus = m[3].length;
      const minus = m[4].length;
      // Bars are scaled to the terminal; split the real count in their ratio.
      const added = plus + minus ? Math.round((n * plus) / (plus + minus)) : 0;
      files.push({ path: m[1].trim(), added, removed: n - added });
    } else if ((m = line.match(/^\s*(.+?)\s+\|\s+Bin (.*)$/))) files.push({ path: m[1].trim(), added: 0, removed: 0, binary: m[2] });
    else if (/\d+ files? changed/.test(line)) summary = line.trim();
  }
  return { files, summary };
}
