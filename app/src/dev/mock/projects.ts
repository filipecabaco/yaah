// Projects, their briefs, the "Add repos" picker and @-mention file search
// (projects.rs, repos.rs).
import type { FileMatch, Project, ProjectStatus, Repo } from "@/lib/api";
import { baseName, home, need, now, ws, type Mock, type Replies } from "./context";

export function seedProjects() {
  const repos: Repo[] = [
    { name: "api", path: `${ws}/api`, remote: "acme/api", branch: "main" },
    { name: "web", path: `${ws}/web`, remote: "acme/web", branch: "feat/new-billing-page" },
    { name: "infra", path: `${ws}/infra`, remote: "acme/infra", branch: "main" },
    { name: "api-billing", path: `${ws}/api-billing`, remote: "acme/api", branch: "fix/invoice-rounding" },
    { name: "docs", path: `${ws}/docs`, remote: "acme/docs", branch: "main" },
    { name: "scratch", path: `${ws}/scratch`, remote: null, branch: "main" },
    { name: "mobile", path: `${ws}/clients/mobile`, remote: "acme/mobile", branch: "release/4.2" },
  ];
  const projects: Project[] = [
    {
      id: "p1",
      name: "billing revamp",
      dirs: [`${ws}/api`, `${ws}/web`],
      status: "ongoing",
      createdAt: 1730000000,
      contextDir: `${home}/.yaah/projects/p1`,
    },
  ];
  return {
    repos,
    projects,
    /** Each project's project.md. */
    briefs: { p1: "# billing revamp\n\nMove invoices to the new pricing model.\n" } as Record<string, string>,
    nextProject: 2,
  };
}

/** A new project, as projects.rs makes one: a `# name` brief, with the statement of work under its heading when given. */
export function addProject(
  { state }: Mock,
  name: string,
  dirs: string[],
  options: { agentId?: string | null; statementOfWork?: string | null } = {},
): Project {
  const id = `p${state.nextProject++}`;
  const p: Project = {
    id,
    name: name.trim() || (dirs[0] ? baseName(dirs[0]) : "Untitled project"),
    dirs: [...new Set(dirs)],
    status: "ongoing",
    createdAt: now(),
    contextDir: `${home}/.yaah/projects/${id}`,
    ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
  };
  state.projects.push(p);
  const sow = options.statementOfWork?.trim();
  state.briefs[id] = sow ? `# ${p.name}\n\n## Statement of work\n\n${sow}\n` : `# ${p.name}\n\n`;
  return p;
}

const files = [
  "src/index.ts",
  "src/billing/invoice.ts",
  "src/billing/pricing.ts",
  "src/components/InvoiceTable.tsx",
  "README.md",
  "package.json",
  "test/billing/invoice.test.ts",
];

/** Every character of the query, in order (the picker's fuzzy match). */
function fuzzy(text: string, query: string): boolean {
  let at = 0;
  for (const c of query) if ((at = text.indexOf(c, at) + 1) === 0) return false;
  return true;
}

export function projectReplies(m: Mock): Replies {
  const { state } = m;
  const project = (id: string) =>
    need(
      state.projects.find((p) => p.id === id),
      `no project ${id}`,
    );
  const update = (id: string, f: (p: Project) => void): Project => {
    const p = project(id);
    f(p);
    return p;
  };
  return {
    list_projects: (): Project[] => state.projects,
    create_project: (args: { name: string; dirs: string[]; agentId?: string | null; statementOfWork?: string | null }): Project => {
      if (args.agentId && !state.profiles.some((a) => a.id === args.agentId))
        throw new Error(`unknown agent \`${args.agentId}\`: pick one from Settings → Agents`);
      return addProject(m, args.name, args.dirs, args);
    },
    set_project_agent: ({ id, agentId }: { id: string; agentId: string | null }) => {
      if (agentId && !state.profiles.some((a) => a.id === agentId)) throw new Error(`unknown agent \`${agentId}\`: pick one from Settings → Agents`);
      return update(id, (p) => {
        if (agentId) p.agentId = agentId;
        else delete p.agentId;
      });
    },
    rename_project: ({ id, name }: { id: string; name: string }) => update(id, (p) => (p.name = name)),
    set_project_status: ({ id, status }: { id: string; status: ProjectStatus }) => update(id, (p) => (p.status = status)),
    add_project_dirs: ({ id, dirs }: { id: string; dirs: string[] }) => update(id, (p) => (p.dirs = [...new Set([...p.dirs, ...dirs])])),
    remove_project_dir: ({ id, dir }: { id: string; dir: string }) => update(id, (p) => (p.dirs = p.dirs.filter((d) => d !== dir))),
    // session.rs `set_project_trust`: the project's chats follow at once, and the UI hears the project changed.
    untrust_project_mcp_server: async ({ id, server }: { id: string; server: string }) => {
      const p = update(id, (p) => (p.trustedMcpServers = (p.trustedMcpServers ?? []).filter((s) => s !== server)));
      await m.emit("projects-changed", { projectId: id });
      return p;
    },
    delete_project: ({ id }: { id: string }) => {
      state.projects = state.projects.filter((p) => p.id !== id);
      return null;
    },
    read_brief: ({ id }: { id: string }) => state.briefs[project(id).id] ?? "",
    write_brief: ({ id, text }: { id: string; text: string }) => {
      state.briefs[project(id).id] = text;
      return null;
    },

    list_repos: () => ({ roots: state.workspaceRoots, repos: state.repos }),
    clone_repo: async ({ source, root }: { source: string; root: string }): Promise<Repo> => {
      await m.wait(1500);
      const name = baseName(source.trim()).replace(/\.git$/, "");
      if (!name) throw new Error("can't tell the repo name from that");
      const path = `${root.replace(/\/+$/, "")}/${name}`;
      if (state.repos.some((r) => r.path === path)) throw new Error(`${path} already exists`);
      // `owner/repo` for GitHub remotes, as repos.rs describes origin.
      const remote = source
        .trim()
        .replace(/^(https?:\/\/github\.com\/|git@github\.com:)/, "")
        .replace(/\.git$/, "");
      const repo: Repo = { name, path, remote, branch: "main" };
      state.repos.push(repo);
      return repo;
    },

    search_files: ({ query }: { query: string }): FileMatch[] =>
      files.filter((f) => fuzzy(f.toLowerCase(), query.toLowerCase())).map((label) => ({ path: `${ws}/api/${label}`, label })),
  };
}
