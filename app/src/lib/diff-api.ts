// Typed binding to the diff pane's command (src-tauri/src/diff_commands.rs, sources/git.rs `working_view`).
import { invoke } from "@tauri-apps/api/core";
import type { DiffMode } from "@/lib/layout";

/** `git.diff`'s answer (sources/git.rs), as far as the pane reads it. */
export type DiffData = {
  text: string;
  files: unknown;
  range: string;
  additions: number;
  deletions: number;
  truncated: boolean;
};

export type DiffRepo = { root: string; name: string; branch: string | null; detached: boolean };

/** `repo: null`: the folder isn't in a repository. `unchanged`: nothing moved since `since` (no `diff`). */
export type DiffView = {
  repo: DiffRepo | null;
  mode?: DiffMode;
  /** The base branch in `branch` mode (Rust's pick when none was asked). */
  base?: string | null;
  fingerprint?: string;
  branches?: string[];
  unchanged?: boolean;
  diff?: DiffData;
  /** Files git doesn't track yet: not in the diff, listed beside it. */
  untracked?: string[];
};

export const diffApi = {
  read: (cwd: string, mode: DiffMode, base?: string, since?: string) =>
    invoke<DiffView>("diff_pane_read", { cwd, mode, base: base ?? null, since: since ?? null }),
};
