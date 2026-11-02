// Settings → Skills (skills.rs): sample skills folders for the Claude profiles
// and a sample GitHub lookup. Repo names are real (checked to hold SKILL.md
// folders); the skills listed for them here are a trimmed, paraphrased sample.
import type { FoundSkill, InstalledSkill, SkillInstalled, SkillInstallRequest, SkillLookup, SkillsOverview } from "@/lib/api";
import { baseName, home, now, type Mock, type Replies } from "./context";

const sha = "ca45fc496a3436251f191354091d557da31c15b5";

const skill = (dir: string, folder: string, description: string, extra: Partial<InstalledSkill> = {}): InstalledSkill => ({
  name: folder,
  description,
  folder,
  dir: `${dir}/${folder}`,
  files: 1,
  linked: false,
  source: null,
  problem: null,
  ...extra,
});
const fromRepo = (repo: string, path: string, daysAgo: number) => ({ repo, ref: "main", path, sha, installedAt: now() - daysAgo * 86400 });

export function seedSkills() {
  const claude = `${home}/.claude/skills`;
  const work = `${home}/.claude-work/skills`;
  const skillFolders: Record<string, InstalledSkill[]> = {
    [claude]: [
      skill(claude, "pdf", "Read, merge, split and fill PDF files; extract text and tables, OCR scanned pages.", {
        files: 11,
        source: fromRepo("anthropics/skills", "skills/pdf", 3),
      }),
      skill(claude, "release-notes", "Draft release notes from merged PRs since the last tag, grouped by area.", { files: 2 }),
      skill(claude, "supabase", "Supabase products, client libraries, auth and RLS: what to check before changing a project.", {
        files: 6,
        linked: true,
      }),
      skill(claude, "half-written", "", { problem: "SKILL.md frontmatter has no `description`" }),
    ],
    [work]: [
      skill(work, "brainstorming", "Turn a rough idea into a design through questions, before any code is written.", {
        source: fromRepo("obra/superpowers", "skills/brainstorming", 12),
      }),
    ],
    [`${home}/.claude-personal/skills`]: [],
  };
  return { skillFolders };
}

type Sample = Omit<FoundSkill, "folder" | "skipped" | "problem" | "installedIn">;
const sample = (path: string, description: string, files: number, bytes: number): Sample => ({
  path,
  name: baseName(path),
  description,
  files,
  bytes,
});
const lookups: Record<string, Sample[]> = {
  "anthropics/skills": [
    sample("skills/brand-guidelines", "Apply a brand's colors and typography to slides, docs and other artifacts.", 2, 13_300),
    sample("skills/docx", "Create and edit Word documents: tracked changes, comments, formatting.", 58, 1_240_000),
    sample("skills/mcp-builder", "Guide for building MCP servers that let models use external services well.", 9, 121_000),
    sample("skills/pdf", "Read, merge, split and fill PDF files; extract text and tables, OCR scanned pages.", 11, 96_000),
    sample("skills/skill-creator", "Create new skills, improve existing ones and measure how well they trigger.", 18, 210_000),
    sample("skills/xlsx", "Spreadsheets with formulas, formatting and charts; recalculate and check for errors.", 4, 48_000),
  ],
  "supabase/agent-skills": [
    sample("skills/supabase", "Supabase products, client libraries, auth and RLS: what to check before changing a project.", 6, 41_000),
    sample("skills/supabase-postgres-best-practices", "Postgres performance and schema guidance from Supabase.", 31, 180_000),
  ],
};

/** Presets whose skills folder skills.rs knows. */
const withSkills = ["claude", "codex", "gemini", "opencode", "copilot", "goose", "qwen", "auggie", "kimi", "vibe"];

const suggested = [
  ["anthropics/skills", "Anthropic's examples: documents (PDF, Word, Excel, slides), art, MCP builder"],
  ["supabase/agent-skills", "Supabase and Postgres best practices"],
  ["vercel-labs/agent-skills", "React, Next.js and Vercel deploys"],
  ["obra/superpowers", "Planning, TDD, debugging and code review workflows"],
  ["cloudflare/skills", "Workers, agents and the Cloudflare platform"],
  ["huggingface/skills", "Training, datasets and the Hugging Face Hub"],
].map(([repo, about]) => ({ repo, about }));

export function skillReplies(m: Mock): Replies {
  const { state } = m;
  const folders = state.skillFolders;
  const allSkills = () => Object.values(folders).flat();

  return {
    list_skills: (): SkillsOverview => {
      // One location per Claude profile's config dir (the other presets' folders aren't sampled).
      const locations = state.profiles
        .filter((p) => p.preset === "claude")
        .map((p) => {
          const dir = `${p.configDir ?? `${home}/.claude`}/skills`;
          return {
            dir,
            label: p.label,
            agents: [{ id: p.id, label: p.label, preset: p.preset }],
            docs: "https://code.claude.com/docs/en/skills",
            exists: dir in folders,
            skills: folders[dir] ?? [],
          };
        });
      return {
        locations,
        defaultTarget: locations.find((l) => l.agents.some((a) => a.id === state.defaultAgent))?.dir ?? locations[0]?.dir ?? null,
        unsupported: state.profiles.filter((p) => !withSkills.includes(p.preset)).map((p) => ({ id: p.id, label: p.label, preset: p.preset })),
        suggested,
      };
    },
    skills_lookup: async ({ input }: { input: string }): Promise<SkillLookup> => {
      await m.wait(500);
      const match = /^([\w-]+\/[\w.-]+)(?:\/(?:tree\/[^/]+\/)?(.*))?$/.exec(input.trim().replace(/^https?:\/\/(www\.)?github\.com\//, ""));
      if (!match) throw new Error("expected owner/repo, owner/repo/path or a github.com link");
      const [, repo, path = ""] = match;
      const all = lookups[repo] ?? [sample("skills/example", `A sample skill from ${repo}.`, 3, 8_000)];
      const skills = all
        .filter((s) => !path || s.path === path || s.path.startsWith(`${path}/`))
        .map((s): FoundSkill => {
          const folder = baseName(s.path);
          return {
            ...s,
            folder,
            skipped: [],
            problem: null,
            installedIn: Object.keys(folders).filter((d) => folders[d].some((k) => k.folder === folder)),
          };
        });
      if (!skills.length) throw new Error(`no SKILL.md found in ${repo}/${path} at main`);
      return { repo, ref: "main", sha, path, skills, authenticated: false, notes: [] };
    },
    skills_install: async ({ request }: { request: SkillInstallRequest }): Promise<SkillInstalled[]> => {
      await m.wait(700);
      const list = (folders[request.target] ??= []);
      return request.paths.map((path) => {
        const s = Object.values(lookups)
          .flat()
          .find((x) => x.path === path);
        const folder = baseName(path);
        const existing = list.findIndex((k) => k.folder === folder);
        if (existing >= 0 && !request.replace) return { path, folder, dir: null, error: `${folder} is already installed there` };
        const installed = skill(request.target, folder, s?.description ?? "", {
          name: s?.name ?? folder,
          files: s?.files ?? 1,
          source: { ...fromRepo(request.repo, path, 0), ref: request.ref, sha: request.sha },
        });
        if (existing >= 0) list.splice(existing, 1, installed);
        else list.push(installed);
        list.sort((a, b) => a.name.localeCompare(b.name));
        return { path, folder, dir: installed.dir, error: null };
      });
    },
    skills_update: async ({ dir }: { dir: string }) => {
      await m.wait(400);
      const source = allSkills().find((k) => k.dir === dir)?.source;
      if (!source) throw new Error("yaah didn't install this skill, so there's nothing to update from");
      return { updated: false, sha: source.sha };
    },
    skills_remove: ({ dir }: { dir: string }) => {
      for (const [d, list] of Object.entries(folders)) folders[d] = list.filter((k) => k.dir !== dir);
      return null;
    },
  };
}
