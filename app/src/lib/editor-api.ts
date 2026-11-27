// Typed bindings to the editor pane's commands (src-tauri/src/editor_commands.rs, sources/git/editor.rs).
// File paths are relative to the pane's folder; Source Control paths are relative to the repository's top folder.
import { invoke } from "@tauri-apps/api/core";

export type DirEntry = { name: string; path: string; dir: boolean; link: boolean };

export type FileRead = {
  text: string;
  binary: boolean;
  tooLarge: boolean;
  size: number;
  /** Size and modified time: a save names it, and is refused when the file moved on since. */
  version: string;
  readonly: boolean;
};

/** The start of the error a save gets when the file changed on disk since it was read (editor_commands.rs `CHANGED`). */
export const CHANGED = "changed on disk";

/** VS Code's letters: Modified, Added, Deleted, Renamed, Copied, Type change, Untracked; `!` a conflict. */
export type ChangeStatus = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "!";
export type Change = { path: string; status: ChangeStatus; oldPath?: string; untracked?: boolean };

export type GitStatus =
  | { repo: null }
  | {
      repo: true;
      fingerprint: string;
      unchanged: true;
    }
  | {
      repo: true;
      fingerprint: string;
      unchanged?: undefined;
      /** The repository's top folder (Source Control paths are relative to it). */
      root: string;
      /** The pane's folder inside the repository (`""` when it is the top), `/`-separated, no trailing `/`. */
      prefix: string;
      name: string;
      branch: string | null;
      detached: boolean;
      oid: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      staged: Change[];
      changes: Change[];
      conflicts: Change[];
      truncated: boolean;
      hasCommits: boolean;
    };
export type RepoStatus = Extract<GitStatus, { root: string }>;

export type GitFile = { text: string; binary: boolean; truncated: boolean } | null;

export type GraphCommit = { sha: string; parents: string[]; short: string; author: string; date: string; subject: string; refs: string[] };

export type FileMatch = { path: string; label: string };

export const editorApi = {
  list: (root: string, dir: string) => invoke<DirEntry[]>("editor_list", { root, dir }),
  read: (root: string, path: string) => invoke<FileRead>("editor_read", { root, path }),
  /** The new version. `version` null: overwrite whatever is on disk. */
  write: (root: string, path: string, text: string, version: string | null) => invoke<string>("editor_write", { root, path, text, version }),
  create: (root: string, path: string, dir: boolean) => invoke<void>("editor_create", { root, path, dir }),
  find: (root: string, query: string) => invoke<FileMatch[]>("editor_find", { root, query }),
  status: (cwd: string, since?: string) => invoke<GitStatus>("editor_git_status", { cwd, since: since ?? null }),
  file: (cwd: string, path: string, side: "HEAD" | "INDEX") => invoke<GitFile>("editor_git_file", { cwd, path, side }),
  stage: (cwd: string, paths: string[]) => invoke<void>("editor_git_stage", { cwd, paths }),
  unstage: (cwd: string, paths: string[]) => invoke<void>("editor_git_unstage", { cwd, paths }),
  discard: (cwd: string, paths: string[]) => invoke<void>("editor_git_discard", { cwd, paths }),
  /** The new commit's short id. */
  commit: (cwd: string, message: string, all: boolean, amend: boolean) => invoke<string>("editor_git_commit", { cwd, message, all, amend }),
  graph: (cwd: string, upstream: string | null, limit?: number) => invoke<GraphCommit[]>("editor_git_graph", { cwd, upstream, limit: limit ?? null }),
};
