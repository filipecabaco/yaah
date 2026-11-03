# Component libraries — shared contract (Rust ↔ frontend)

## The feature
Users install libraries of UI components made by others (people, companies), keep their own
collection, and share theirs. Components are data (see `app/src-tauri/src/ui_library.rs` header),
never code, so an installed library can only render UI from yaah's primitives.

## Library format (what authors publish)
A git repo (or a local folder) with:
```
yaah-library.json        manifest (required, ≤ 64 KB)
components/<name>.json   one component per file, same format as app/src-tauri/components/*.json
README.md                optional, shown nowhere yet
```
Manifest:
```json
{ "name": "acme", "title": "Acme components", "description": "What's in it",
  "publisher": "Acme Inc.", "homepage": "https://…", "version": "1.2.0" }
```
- `name`: the library id and namespace. Same rule as component names (kebab-case, 2-32 chars).
  `yaah` and `local` are reserved.
- A component's `name` field is its short name and must equal the file stem.
- Inside the app a library component is addressed as `<library>/<name>` (e.g. `acme/pr-card`)
  everywhere: catalog, `$component` references, `ui_render`'s `component`, the UI.
- Inside a library, references to its own components are qualified (`acme/card`); unqualified
  references may only name yaah's bundled components or primitives (never the user's local
  ones, which differ per user). References to another library (`other/x`) are allowed and
  reported as `needs: ["other"]`.
- Limits: ≤ 500 components, ≤ 256 KB per component file, regular files only (symlinks are
  skipped and reported), every component validated with the existing validator and expansion
  budget. Invalid components are reported and not loaded; the rest load.

## Storage
- Records: `~/.config/yaah/libraries.json` (via `json_file`), list of
  `{ id, source: {kind:"git", url, ref?} | {kind:"folder", path}, commit?, enabled, installedAt, updatedAt }`.
- Git checkouts: `~/.yaah/libraries/<id>/`. Folder libraries are read in place, live (so authors
  see edits without reinstalling).

## Tauri commands (camelCase JSON; all async, blocking work off the main thread)
```ts
type LibrarySource = { kind: "git"; url: string; ref?: string } | { kind: "folder"; path: string };

type LibraryComponent = { name: string /* qualified, e.g. "acme/pr-card" */; description: string; valid: boolean; error?: string };

type LibraryInfo = {
  id: string;                 // "yaah" (bundled), "local" (the user's own), or the manifest name
  kind: "builtin" | "local" | "git" | "folder";
  title: string; description: string; publisher?: string; homepage?: string; version?: string;
  source?: LibrarySource;     // git/folder only
  commit?: string;            // git only, full sha
  enabled: boolean;           // builtin/local always true
  components: LibraryComponent[];
  reads: string[];            // source kinds its components' `live` nodes read, e.g. ["github","postgres"], sorted, unique (prefix before the first ".")
  needs: string[];            // other libraries it references
  errors: string[];           // library-level problems (missing manifest field, skipped symlink, ...)
  installedAt?: number; updatedAt?: number;
};

type LibraryPreview = LibraryInfo & { stagingId: string; replaces?: string /* id already installed with that name */ };

list_libraries(): LibraryInfo[]                             // builtin first, then local, then installed by title
inspect_library({ source: LibrarySource }): LibraryPreview  // fetch into a staging dir and validate; installs nothing
install_library({ stagingId: string }): LibraryInfo         // moves staging into place (replacing `replaces`), enables it
update_library({ id: string }): { library: LibraryInfo; from?: string; to?: string; changed: string[] }   // git: fetch+reset to ref; folder: re-read
set_library_enabled({ id: string, enabled: boolean }): LibraryInfo
remove_library({ id: string }): void
copy_component({ name: string /* qualified */, newName?: string }): Component   // into the local collection; refs to its own library stay qualified; errors if newName taken
export_library({ dir: string, manifest: { name, title, description, publisher?, homepage?, version }, components: string[] /* local names */ }): { path: string; missing: string[] }
  // writes <dir>/<name>/{yaah-library.json, components/*.json, README.md}; rewrites refs to exported
  // siblings to `<name>/<sibling>`; if a component references a local component not in the list,
  // writes nothing and returns `missing` (non-empty) so the UI can offer to add them; refuses a
  // non-empty target folder.
```
Errors are strings written for the user. Event `libraries-changed` (no payload) after any change, so
open views reload. `list_components` keeps working and now includes enabled library components
with `source` = the library id; `Component` gains `library?: string` (the library title) — keep it optional.

## Fetching safely (Rust)
- `git` via `path_env::command`, never a shell. `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` unset,
  `-c protocol.allow=never -c protocol.https.allow=always -c protocol.ssh.allow=always
  -c core.symlinks=false -c core.hooksPath=/dev/null`, `clone --depth 1 --no-recurse-submodules
  --single-branch [--branch <ref>] -- <url> <dir>`, 120 s timeout, killed on drop.
- URL must be `https://…`, `ssh://…` or scp-like `user@host:path`, never start with `-`; ref must
  match `[A-Za-z0-9._/-]+` and not start with `-`.
- For `https://github.com/` URLs, when the GitHub integration is connected, pass the token through
  env (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` setting
  `http.https://github.com/.extraheader` to `Authorization: Basic base64("x-access-token:<token>")`),
  never on the command line. Otherwise private repos use the user's own git credentials (SSH keys,
  credential helper).
- Never follow symlinks when reading a library; reject paths escaping the library root.

## Agents
- Catalog lists enabled library components by qualified name with `source`; the syntax notes in
  `src/ui-primitives.json` gain one line: library components are referenced as `library/name`.
- `ui_save_component` only ever writes the local collection (qualified names are refused with a
  message saying to copy it to the collection first).
