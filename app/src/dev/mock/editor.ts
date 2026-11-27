// A fake folder for the editor pane (editor_commands.rs, sources/git/editor.rs): any folder holds
// the same small Elixir/TypeScript project with a few changes, except ones named `plain` or
// `scratch`, which are not repositories. Edits, stages, discards and commits change it in memory.
import type { Replies } from "./context";
import { baseName } from "./context";

type Change = { path: string; status: string; untracked?: boolean };

const HEAD: Record<string, string> = {
  "README.md": "# billing\n\nA small service that sends invoices.\n",
  "mix.exs":
    'defmodule Billing.MixProject do\n  use Mix.Project\n\n  def project do\n    [app: :billing, version: "0.1.0", elixir: "~> 1.17", deps: deps()]\n  end\n\n  defp deps, do: [{:req, "~> 0.5"}]\nend\n',
  "lib/billing.ex":
    'defmodule Billing do\n  @moduledoc "Invoices."\n\n  def total(lines) do\n    Enum.reduce(lines, 0, fn %{qty: q, price: p}, acc -> acc + q * p end)\n  end\nend\n',
  "lib/billing/mailer.ex": "defmodule Billing.Mailer do\n  def send(invoice), do: {:ok, invoice}\nend\n",
  "web/src/app.ts": "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n",
};

type Tree = Record<string, string>;

function fresh(): { head: Tree; index: Tree; work: Tree; edits: number; commits: number } {
  const head: Tree = { ...HEAD };
  const index: Tree = { ...head, "lib/billing/tax.ex": "defmodule Billing.Tax do\n  def rate, do: 0.23\nend\n" };
  const work: Tree = {
    ...index,
    "lib/billing.ex": head["lib/billing.ex"].replace("acc + q * p", "acc + q * p * (1 + Billing.Tax.rate())"),
    "web/src/app.ts": head["web/src/app.ts"].replace("Hello", "Hi"),
    "notes.txt": "remember the tax rounding\n",
  };
  return { head, index, work, edits: 0, commits: 3 };
}

let repo = fresh();
const versions = new Map<string, number>();
const version = (p: string) => `${(repo.work[p] ?? "").length}:${versions.get(p) ?? 0}`;
const bump = (p: string) => {
  versions.set(p, (versions.get(p) ?? 0) + 1);
  repo.edits++;
};

function diffOf(a: Record<string, string>, b: Record<string, string>, untracked = false): Change[] {
  const out: Change[] = [];
  for (const p of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (!(p in a)) out.push(untracked ? { path: p, status: "U", untracked: true } : { path: p, status: "A" });
    else if (!(p in b)) out.push({ path: p, status: "D" });
    else if (a[p] !== b[p]) out.push({ path: p, status: "M" });
  }
  return out;
}

const notRepo = (cwd: string) => ["plain", "scratch"].includes(baseName(cwd));

export function editorReplies(): Replies {
  return {
    editor_list: ({ dir }: { root: string; dir: string }) => {
      const prefix = dir ? `${dir}/` : "";
      const seen = new Map<string, boolean>();
      for (const p of Object.keys(repo.work)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const [first, ...more] = rest.split("/");
        seen.set(first, more.length > 0 || seen.get(first) === true);
      }
      return [...seen]
        .map(([name, isDir]) => ({ name, path: `${prefix}${name}`, dir: isDir, link: false }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    },
    editor_read: ({ path }: { root: string; path: string }) => {
      if (!(path in repo.work)) throw new Error(`${path} doesn't exist`);
      return { text: repo.work[path], binary: false, tooLarge: false, size: repo.work[path].length, version: version(path), readonly: false };
    },
    editor_write: ({ path, text, version: v }: { path: string; text: string; version: string | null }) => {
      if (v && v !== version(path)) throw new Error(`changed on disk: ${path} was changed by something else since it was opened`);
      repo.work[path] = text;
      bump(path);
      return version(path);
    },
    editor_create: ({ path, dir }: { path: string; dir: boolean }) => {
      if (path in repo.work) throw new Error(`${path} already exists`);
      repo.work[dir ? `${path}/.keep` : path] = "";
      bump(path);
      return null;
    },
    editor_find: ({ query }: { query: string }) =>
      Object.keys(repo.work)
        .filter((p) => p.toLowerCase().includes(query.toLowerCase()))
        .map((p) => ({ path: `/mock/${p}`, label: p })),
    editor_git_status: ({ cwd, since }: { cwd: string; since: string | null }) => {
      if (notRepo(cwd)) return { repo: null };
      const fingerprint = `fp${repo.edits}`;
      if (since === fingerprint) return { repo: true, fingerprint, unchanged: true };
      return {
        repo: true,
        fingerprint,
        root: cwd,
        prefix: "",
        name: baseName(cwd),
        branch: "feat/tax",
        detached: false,
        oid: `c0ffee${repo.commits}`,
        upstream: "origin/feat/tax",
        ahead: repo.commits - 3,
        behind: 1,
        staged: diffOf(repo.head, repo.index),
        changes: diffOf(repo.index, repo.work, true),
        conflicts: [],
        truncated: false,
        hasCommits: true,
      };
    },
    editor_git_file: ({ path, side }: { path: string; side: string }) => {
      const src = side === "HEAD" ? repo.head : repo.index;
      return path in src ? { text: src[path], binary: false, truncated: false } : null;
    },
    editor_git_stage: ({ paths }: { paths: string[] }) => {
      for (const p of paths) {
        if (p in repo.work) repo.index[p] = repo.work[p];
        else delete repo.index[p];
      }
      repo.edits++;
      return null;
    },
    editor_git_unstage: ({ paths }: { paths: string[] }) => {
      for (const p of paths) {
        if (p in repo.head) repo.index[p] = repo.head[p];
        else delete repo.index[p];
      }
      repo.edits++;
      return null;
    },
    editor_git_discard: ({ paths }: { paths: string[] }) => {
      for (const p of paths) {
        if (p in repo.index) repo.work[p] = repo.index[p];
        else delete repo.work[p];
        bump(p);
      }
      return null;
    },
    editor_git_commit: ({ message, all }: { message: string; all: boolean }) => {
      if (!message.trim()) throw new Error("a commit needs a message");
      if (all) for (const p of Object.keys(repo.index)) if (p in repo.work) repo.index[p] = repo.work[p];
      if (!diffOf(repo.head, repo.index).length) throw new Error("nothing added to commit");
      repo.head = { ...repo.index };
      repo.commits++;
      repo.edits++;
      return `c0ffee${repo.commits}`;
    },
    editor_git_graph: () => {
      const mine = Array.from({ length: repo.commits - 3 }, (_, i) => ({
        sha: `c0ffee${repo.commits - i}`,
        parents: [`c0ffee${repo.commits - i - 1}`],
        short: `c0ffee${repo.commits - i}`,
        author: "You",
        date: new Date().toISOString(),
        subject: `Work in progress ${repo.commits - i}`,
        refs: i === 0 ? ["HEAD -> feat/tax"] : [],
      }));
      const base = [
        {
          sha: "c0ffee3",
          parents: ["m2", "f1"],
          short: "c0ffee3",
          author: "Ada",
          date: "2026-11-20T10:00:00Z",
          subject: "Merge branch 'fix/rounding'",
          refs: mine.length ? ["origin/feat/tax"] : ["HEAD -> feat/tax", "origin/feat/tax"],
        },
        { sha: "f1", parents: ["m1"], short: "f1", author: "Grace", date: "2026-11-19T10:00:00Z", subject: "Round invoice totals", refs: [] },
        { sha: "m2", parents: ["m1"], short: "m2", author: "Ada", date: "2026-11-18T10:00:00Z", subject: "Add the mailer", refs: ["origin/main"] },
        { sha: "m1", parents: [], short: "m1", author: "Ada", date: "2026-11-17T10:00:00Z", subject: "Initial commit", refs: [] },
      ];
      return [...mine, ...base];
    },
  };
}

/** A clean slate between tests. */
export function resetFakeEditorRepo() {
  repo = fresh();
  versions.clear();
}
