// A fake repository for the diff pane (diff_commands.rs, sources/git.rs `working_view`): any folder
// is a repo with the recorded feature-branch diff, except ones named `plain` or `scratch`, which
// are not. `touchFakeRepo()` makes the next poll see a change, as an edit on disk would.
import { asArray, asObj, asString } from "@/lib/narrow";
import type { Replies } from "./context";
import { baseName } from "./context";
import { sourceSamples } from "./fixtures";

let edits = 0;
/** Pretend a file changed: the fingerprint moves, so the pane re-reads. */
export function touchFakeRepo() {
  edits++;
}

const BRANCHES = ["feat/new-billing-page", "main", "release/4.2", "origin/main"];

export function diffReplies(): Replies {
  return {
    diff_pane_read: ({ cwd, mode, base, since }: { cwd: string; mode: string; base: string | null; since: string | null }) => {
      const name = baseName(cwd);
      if (name === "plain" || name === "scratch") return { repo: null };
      const resolved = mode === "branch" ? (base ?? "main") : null;
      const fingerprint = `${mode}:${resolved ?? ""}:${edits}`;
      const repo = { root: cwd, name, branch: "feat/new-billing-page", detached: false };
      const view = { repo, mode, base: resolved, fingerprint, branches: BRANCHES, untracked: ["notes.txt"] };
      if (since === fingerprint) return { ...view, unchanged: true };
      const sample = asObj(sourceSamples["git.diff"]);
      const files = asArray(sample.files);
      const chunks = (asString(sample.text) ?? "").split(/(?=^diff --git )/m);
      // Staged: the first file; unstaged: the others; all and branch: everything.
      const keep = (i: number) => (mode === "staged" ? i === 0 : mode === "unstaged" ? i > 0 : true);
      const picked = files.filter((_, i) => keep(i));
      const paths = new Set(picked.map((f) => asObj(f).path));
      const text = chunks.filter((c) => paths.has(/^diff --git a\/\S+ b\/(\S+)/.exec(c)?.[1])).join("");
      const sum = (k: string) => picked.reduce<number>((n, f) => n + Number(asObj(f)[k] ?? 0), 0);
      return {
        ...view,
        diff: {
          ...sample,
          range: mode === "branch" ? `${resolved}` : mode === "all" ? "HEAD" : mode,
          staged: mode === "staged",
          files: picked,
          text,
          additions: sum("additions"),
          deletions: sum("deletions"),
        },
      };
    },
  };
}
