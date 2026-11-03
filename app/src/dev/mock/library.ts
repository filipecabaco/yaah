// The component library (ui_library.rs) and component libraries: what yaah
// ships, what Claude saved in the live_scenarios run, the one it built in the
// live_ui run, one installed library ("platform", from git) and one to install
// ("acme", from Acme Inc.: three components, one of them invalid).
import type { LibraryExport, LibraryInfo, LibraryManifest, LibraryPreview, LibrarySource, LibraryUpdate, UiComponent } from "@/lib/api";
import { asObj, asString, isObj, type Obj } from "@/lib/narrow";
import catalogue from "@/ui-primitives.json";
import { home, now, type Mock, type Replies } from "./context";
import { bundledComponents, component, recordings } from "./fixtures";

/** Rebuilt from the recorded `ui_save_component` calls. */
const scenarioComponents = recordings.scenarios.flatMap((s) =>
  s.event === "session-entry" && s.entry.type === "tool" && s.entry.title.endsWith("ui_save_component")
    ? [component(s.entry.rawInput, "local", 1793556372)]
    : [],
);

/** The first UI the live_ui agent rendered: its new component, expanded into a `$component` node. */
const builtEntry = recordings.ui.flatMap((s) => (s.event === "session-entry" && s.entry.type === "ui" ? [s.entry] : []))[0];
if (!builtEntry) throw new Error("browser mock: live-ui.json renders no UI");
const builtNode = asObj(builtEntry.tree);
const built: UiComponent = {
  name: builtEntry.component ?? "service-status-overview",
  version: builtEntry.version ?? 1,
  description: "Grid of service cards, each with a coloured status line and an optional metric. Use for health overviews of several services.",
  props: {
    type: "object",
    properties: { title: { type: "string" }, columns: { type: "number" }, services: { type: "array" } },
    required: ["services"],
  },
  tree: builtNode.tree,
  examples: [{ title: "Three services", props: builtEntry.props }],
  changeNote: null,
  updatedAt: 1793550000,
  source: "local",
  uses: [],
};

const exampleProps = (name: string) => scenarioComponents.find((c) => c.name === name)?.examples[0]?.props ?? {};

/** A local component made of two others, so sharing it asks for them too. */
const opsBoard = component(
  {
    name: "ops-board",
    description: "The agents that are running and the scheduled jobs, side by side. Use for a morning check of what's in flight.",
    props: { type: "object", properties: {} },
    tree: {
      type: "grid",
      props: { columns: 2 },
      children: [
        { type: "agent-status-panel", props: exampleProps("agent-status-panel") },
        { type: "cron-schedule", props: exampleProps("cron-schedule") },
      ],
    },
    examples: [{ title: "Today", props: {} }],
  },
  "local",
  1793560000,
);

// ── libraries out there (what inspect_library fetches) ──────────────────────

type Def = { name: string; description: string; tree: unknown; props?: Obj; example?: Obj; error?: string };
type Published = {
  manifest: LibraryManifest;
  /** The newest commit of its ref; updates move to it. */
  commit: string;
  /** What changed in the newest commit, for Update. */
  changes?: string[];
  components: Def[];
  errors: string[];
};

const acme: Published = {
  manifest: {
    name: "acme",
    title: "Acme components",
    description: "Pull request cards and a review queue, the way Acme's teams look at GitHub.",
    publisher: "Acme Inc.",
    homepage: "https://acme.example/yaah",
    version: "1.2.0",
  },
  commit: "4f1c9e2a7b3d5e6f8091a2b3c4d5e6f708192a3b",
  components: [
    {
      name: "pr-card",
      description: "One pull request as a card: title, author, review state, checks and size, live from GitHub.",
      props: { type: "object", properties: { repo: { type: "string" }, number: { type: "number" } }, required: ["repo", "number"] },
      example: { repo: "supabase/realtime", number: 2476 },
      tree: {
        type: "live",
        props: { source: { kind: "github.pr", repo: "{{repo}}", number: "{{number}}" }, every: 120000, as: "pr" },
        children: [
          {
            type: "card",
            props: { title: "#{{pr.number}} {{pr.title}}", description: "{{pr.author}} · {{pr.stateLabel}}" },
            children: [
              {
                type: "stack",
                props: { direction: "row", gap: "sm", wrap: true },
                children: [
                  { type: "badge", props: { text: "{{pr.reviewLabel}}", variant: "secondary" } },
                  { type: "badge", props: { text: "{{pr.checksSummary.pass}} checks passed", variant: "outline" } },
                ],
              },
              { type: "text", props: { text: "+{{pr.additions}} −{{pr.deletions}} in {{pr.changedFiles}} files", tone: "muted", size: "sm" } },
            ],
          },
        ],
      },
    },
    {
      name: "review-queue",
      description: "Open pull requests waiting for review in a repo, oldest first, with their checks.",
      props: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
      example: { repo: "supabase/realtime" },
      tree: {
        type: "card",
        props: { title: "Waiting for review", description: "{{repo}}" },
        children: [
          {
            type: "live",
            props: { source: { kind: "github.prs", repo: "{{repo}}", state: "open" }, every: 120000, as: "prs" },
            children: [
              {
                type: "table",
                props: {
                  columns: [
                    { key: "number", label: "#", align: "right" },
                    { key: "title", label: "Title" },
                    { key: "author", label: "Author" },
                    { key: "checks", label: "Checks" },
                  ],
                  rows: "{{prs}}",
                  empty: "Nothing waiting.",
                },
              },
            ],
          },
        ],
      },
    },
    {
      name: "burndown",
      description: "Issues closed per day against the sprint's line.",
      tree: { type: "sparkline", props: { values: "{{days}}" } },
      error: "tree: `sparkline` is not a primitive or a component (did you mean `chart`?)",
    },
  ],
  errors: [],
};

const platform: Published = {
  manifest: {
    name: "platform",
    title: "Platform kit",
    description: "What the platform team checks first: the machine and the containers on it.",
    publisher: "Northwind platform team",
    version: "0.4.1",
  },
  commit: "9d2b7c41e0aa5f3b6c8d9e0f1a2b3c4d5e6f7081",
  changes: ["platform/containers"],
  components: [
    {
      name: "host-health",
      description: "CPU, memory and load of this machine, refreshed every 5 seconds.",
      example: {},
      tree: {
        type: "live",
        props: { source: { kind: "system" }, every: 5000, as: "sys" },
        children: [
          {
            type: "grid",
            props: { columns: 3 },
            children: [
              { type: "stat", props: { label: "CPU", value: "{{sys.cpu}}%" } },
              { type: "stat", props: { label: "Memory", value: "{{sys.memPct}}%" } },
              { type: "stat", props: { label: "Load", value: "{{sys.load1}}" } },
            ],
          },
        ],
      },
    },
    {
      name: "containers",
      description: "Docker containers with their image, state and ports.",
      example: {},
      tree: {
        type: "card",
        props: { title: "Containers" },
        children: [
          {
            type: "live",
            props: { source: { kind: "docker.containers" }, every: 10000, as: "cs" },
            children: [
              {
                type: "table",
                props: {
                  columns: [
                    { key: "name", label: "Name" },
                    { key: "image", label: "Image" },
                    { key: "status", label: "Status" },
                    { key: "ports", label: "Ports" },
                  ],
                  rows: "{{cs}}",
                },
              },
            ],
          },
        ],
      },
    },
  ],
  errors: ["Skipped components/latest.json: it is a symbolic link."],
};

const ACME_URL = "https://github.com/acme-inc/yaah-components";
const PLATFORM_URL = "https://github.com/northwind/yaah-platform";
/** Git URLs inspect_library can fetch. */
const published: Record<string, Published> = { [ACME_URL]: acme, [PLATFORM_URL]: platform };

// ── reading trees ───────────────────────────────────────────────────────────

const primitives = new Set(Object.keys(catalogue.primitives));

function walk(node: unknown, visit: (n: Obj) => void) {
  if (Array.isArray(node)) for (const n of node) walk(n, visit);
  else if (isObj(node)) {
    visit(node);
    walk(node.children, visit);
    walk(node.else, visit);
  }
}

/** Source kinds (before the first ".") its live nodes read. */
function readsOf(trees: unknown[]): string[] {
  const out = new Set<string>();
  for (const t of trees)
    walk(t, (n) => {
      const kind = n.type === "live" ? asString(asObj(asObj(n.props).source).kind) : undefined;
      if (kind) out.add(kind.split(".")[0]);
    });
  return [...out].sort();
}

/** Component names a tree references (anything that isn't a primitive). */
function refsOf(tree: unknown): string[] {
  const out = new Set<string>();
  walk(tree, (n) => {
    const type = asString(n.type);
    if (type && type !== "$component" && !primitives.has(type)) out.add(type);
  });
  return [...out];
}

/** Component nodes replaced by `$component` nodes, as Rust expands them for rendering. */
function expand(node: unknown, find: (name: string) => UiComponent | undefined, depth = 0): unknown {
  if (Array.isArray(node)) return node.map((n) => expand(n, find, depth));
  if (!isObj(node) || depth > 8) return node;
  const c = typeof node.type === "string" ? find(node.type) : undefined;
  if (c) return { type: "$component", name: c.name, version: c.version, props: asObj(node.props), tree: expand(c.tree, find, depth + 1) };
  const out: Obj = { ...node };
  if (node.children !== undefined) out.children = expand(node.children, find, depth);
  if (node.else !== undefined) out.else = expand(node.else, find, depth);
  return out;
}

// ── state ───────────────────────────────────────────────────────────────────

type Installed = {
  id: string;
  source: LibrarySource;
  commit?: string;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
  lib: Published;
};
type Staged = { source: LibrarySource; lib: Published };

export function seedLibrary() {
  return {
    /** The user's own collection (~/.yaah/components). */
    localComponents: structuredClone([...scenarioComponents, built, opsBoard]),
    installedLibraries: [
      {
        id: "platform",
        source: { kind: "git", url: PLATFORM_URL, ref: "main" },
        commit: "1a7e3f90c2b44d6e8f0a1b2c3d4e5f6071829304",
        enabled: true,
        installedAt: now() - 9 * 86400,
        updatedAt: now() - 9 * 86400,
        lib: structuredClone(platform),
      },
    ] as Installed[],
    staged: {} as Record<string, Staged>,
    /** Folders export_library wrote, with what is in them. */
    exported: {} as Record<string, Published>,
  };
}

const KEBAB = /^[a-z][a-z0-9-]{1,31}$/;

export function libraryReplies(m: Mock): Replies {
  const { state } = m;

  const libComponents = (i: { id: string; lib: Published }, updatedAt: number): UiComponent[] =>
    i.lib.components
      .filter((d) => !d.error)
      .map((d) => ({
        ...component({ ...d, examples: d.example ? [{ title: "Example", props: d.example }] : [] }, i.id, updatedAt),
        name: `${i.id}/${d.name}`,
        library: i.lib.manifest.title,
      }));
  const allComponents = (): UiComponent[] => [
    ...bundledComponents,
    ...state.localComponents,
    ...state.installedLibraries.filter((i) => i.enabled).flatMap((i) => libComponents(i, i.updatedAt)),
  ];
  const find = (name: string) => allComponents().find((c) => c.name === name);

  const info = (id: string, kind: LibraryInfo["kind"], lib: Published, extra: Partial<LibraryInfo> = {}): LibraryInfo => ({
    id,
    kind,
    ...lib.manifest,
    enabled: true,
    components: lib.components.map((d) => ({
      name: `${id}/${d.name}`,
      description: d.description,
      valid: !d.error,
      ...(d.error ? { error: d.error } : {}),
    })),
    reads: readsOf(lib.components.filter((d) => !d.error).map((d) => d.tree)),
    needs: [],
    errors: lib.errors,
    ...extra,
  });
  const installedInfo = (i: Installed) =>
    info(i.id, i.source.kind, i.lib, {
      source: i.source,
      commit: i.commit,
      enabled: i.enabled,
      installedAt: i.installedAt,
      updatedAt: i.updatedAt,
    });
  const installed = (id: string) => {
    const i = state.installedLibraries.find((x) => x.id === id);
    if (!i) throw new Error(id === "yaah" || id === "local" ? "yaah's own components and yours can't be changed here" : `no library ${id}`);
    return i;
  };
  const changed = () => void m.emit("libraries-changed", null);

  /** What a git URL or folder holds, or why it can't be read. */
  function fetch(source: LibrarySource): Published {
    if (source.kind === "folder") {
      const path = source.path.replace(/\/+$/, "");
      if (state.exported[path]) return state.exported[path];
      return { ...acme, manifest: { ...acme.manifest, version: "1.3.0-dev" } };
    }
    const url = source.url.trim();
    if (url.startsWith("-") || !/^(https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(url))
      throw new Error("Use an https:// or ssh:// git URL, or git@host:owner/repo.");
    if (source.ref && (source.ref.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(source.ref)))
      throw new Error(`"${source.ref}" isn't a branch or tag name.`);
    const lib = published[url.replace(/\.git$/, "").replace(/\/+$/, "")];
    if (!lib)
      throw new Error(
        `git couldn't read ${url}: repository not found. If it's private, connect GitHub in Settings → Integrations or set up git credentials for it.`,
      );
    if (source.ref && !["main", "v" + lib.manifest.version].includes(source.ref)) throw new Error(`${url} has no branch or tag "${source.ref}".`);
    return lib;
  }

  return {
    list_components: (): UiComponent[] => allComponents(),
    preview_component: ({ name, props }: { name: string; props: Obj }) => {
      const c = find(name);
      // Anything else previews as the live_ui component, with its recorded expansion.
      if (!c || c.name === built.name) return { tree: builtNode, props };
      return { tree: { type: "$component", name, version: c.version, props, tree: expand(c.tree, find) }, props };
    },

    list_libraries: (): LibraryInfo[] => [
      {
        id: "yaah",
        kind: "builtin",
        title: "yaah",
        description: "The components that ship with yaah: GitHub, Linear, Docker, Postgres, git and files.",
        version: "0.1.0",
        enabled: true,
        components: bundledComponents.map((c) => ({ name: c.name, description: c.description, valid: true })),
        reads: readsOf(bundledComponents.map((c) => c.tree)),
        needs: [],
        errors: [],
      },
      {
        id: "local",
        kind: "local",
        title: "My components",
        description: `What agents built for you and what you copied in. Kept in ${home}/.yaah/components.`,
        enabled: true,
        components: state.localComponents.map((c) => ({ name: c.name, description: c.description, valid: true })),
        reads: readsOf(state.localComponents.map((c) => c.tree)),
        needs: [],
        errors: [],
      },
      ...[...state.installedLibraries].sort((a, b) => a.lib.manifest.title.localeCompare(b.lib.manifest.title)).map(installedInfo),
    ],
    inspect_library: async ({ source }: { source: LibrarySource }): Promise<LibraryPreview> => {
      await m.wait(source.kind === "git" ? 900 : 300);
      const lib = fetch(source);
      const stagingId = `stage-${Math.random().toString(36).slice(2, 10)}`;
      state.staged[stagingId] = { source, lib };
      const id = lib.manifest.name;
      const replaces = state.installedLibraries.some((i) => i.id === id) ? id : undefined;
      return {
        ...info(id, source.kind, lib, { source, commit: source.kind === "git" ? lib.commit : undefined }),
        stagingId,
        ...(replaces ? { replaces } : {}),
      };
    },
    install_library: async ({ stagingId }: { stagingId: string }): Promise<LibraryInfo> => {
      await m.wait(300);
      const staged = state.staged[stagingId];
      if (!staged) throw new Error("That preview has expired; inspect the library again.");
      delete state.staged[stagingId];
      const id = staged.lib.manifest.name;
      const entry: Installed = {
        id,
        source: staged.source,
        commit: staged.source.kind === "git" ? staged.lib.commit : undefined,
        enabled: true,
        installedAt: now(),
        updatedAt: now(),
        lib: structuredClone(staged.lib),
      };
      state.installedLibraries = [...state.installedLibraries.filter((i) => i.id !== id), entry];
      changed();
      return installedInfo(entry);
    },
    update_library: async ({ id }: { id: string }): Promise<LibraryUpdate> => {
      await m.wait(700);
      const i = installed(id);
      i.updatedAt = now();
      if (i.source.kind === "folder") {
        changed();
        return { library: installedInfo(i), changed: [] };
      }
      const from = i.commit;
      const to = i.lib.commit;
      i.commit = to;
      const diff = from === to ? [] : (i.lib.changes ?? []);
      changed();
      return { library: installedInfo(i), from, to, changed: diff };
    },
    set_library_enabled: ({ id, enabled }: { id: string; enabled: boolean }): LibraryInfo => {
      const i = installed(id);
      i.enabled = enabled;
      changed();
      return installedInfo(i);
    },
    remove_library: ({ id }: { id: string }) => {
      installed(id);
      state.installedLibraries = state.installedLibraries.filter((i) => i.id !== id);
      changed();
      return null;
    },
    copy_component: ({ name, newName }: { name: string; newName?: string | null }): UiComponent => {
      const from = find(name);
      if (!from) throw new Error(`no component ${name}`);
      if (from.source === "local") throw new Error(`${name} is already in your collection`);
      const target = (newName ?? "").trim() || name.split("/").pop() || name;
      if (!KEBAB.test(target))
        throw new Error(`"${target}" isn't a valid name: use 2-32 lowercase letters, digits and dashes, starting with a letter.`);
      if (state.localComponents.some((c) => c.name === target) || bundledComponents.some((c) => c.name === target))
        throw new Error(`You already have a component called "${target}". Pick another name.`);
      const { library: _library, ...rest } = structuredClone(from);
      const copy: UiComponent = { ...rest, name: target, version: 1, source: "local", changeNote: `Copied from ${name}.`, updatedAt: now() };
      state.localComponents = [...state.localComponents, copy].sort((a, b) => a.name.localeCompare(b.name));
      changed();
      return copy;
    },
    export_library: async ({
      dir,
      manifest,
      components,
    }: {
      dir: string;
      manifest: LibraryManifest;
      components: string[];
    }): Promise<LibraryExport> => {
      await m.wait(300);
      if (!KEBAB.test(manifest.name) || ["yaah", "local"].includes(manifest.name))
        throw new Error(`"${manifest.name}" can't be a library name: use 2-32 lowercase letters, digits and dashes (not "yaah" or "local").`);
      if (!manifest.title.trim()) throw new Error("Give the library a title.");
      if (!manifest.version.trim()) throw new Error("Give the library a version, e.g. 1.0.0.");
      if (components.length === 0) throw new Error("Pick at least one of your components.");
      const picked = components.map((n) => {
        const c = state.localComponents.find((x) => x.name === n);
        if (!c) throw new Error(`${n} isn't one of your components`);
        return c;
      });
      const path = `${dir.replace(/\/+$/, "")}/${manifest.name}`;
      const locals = new Set(state.localComponents.map((c) => c.name));
      const missing = [...new Set(picked.flatMap((c) => refsOf(c.tree)).filter((r) => locals.has(r) && !components.includes(r)))].sort();
      if (missing.length) return { path, missing };
      if (state.exported[path]) throw new Error(`${path} already exists and isn't empty. Pick another folder.`);
      state.exported[path] = {
        manifest,
        commit: "",
        components: picked.map((c) => ({ name: c.name, description: c.description, tree: c.tree, props: c.props, example: c.examples[0]?.props })),
        errors: [],
      };
      return { path, missing: [] };
    },
  };
}

/** Folder pickers on the library screens get a sample folder, so their flows run in a browser; others act as if cancelled. */
export function pickFolder(options: unknown): string | null {
  const title = asString(asObj(asObj(options).options).title) ?? "";
  if (/component library/i.test(title)) return `${home}/workspace/acme-components`;
  if (/save the library/i.test(title)) return `${home}/Documents`;
  return null;
}
