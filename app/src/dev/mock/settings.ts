// Settings → General: appearance, themes (with one custom drop-in, "harbor"),
// tool-card rules, workspace folders and data folders.
import type { AgentGuide, Appearance, GeneralSettings, GuideRoute } from "@/lib/api";
// The real templates Rust embeds (src-tauri/agent-guide/), so Settings shows what agents are told.
import guideTemplate from "../../../src-tauri/agent-guide/guide.md?raw";
import uiSkill from "../../../src-tauri/agent-guide/yaah-ui.md?raw";
import componentsSkill from "../../../src-tauri/agent-guide/yaah-components.md?raw";
import { home, ws, type Mock, type Replies } from "./context";
import { bundledComponents } from "./fixtures";

type CardMode = GeneralSettings["toolCards"]["rules"][string];

const cardDefaults: Record<string, CardMode> = {
  ToolSearch: "collapsed",
  "Load skill": "collapsed",
  Skill: "collapsed",
  TodoWrite: "collapsed",
  "mcp__yaah-ui": "collapsed",
  mcp__fetch: "collapsed",
  "kind:fetch": "collapsed",
  Fetch: "collapsed",
  WebFetch: "collapsed",
  WebSearch: "collapsed",
  "kind:execute": "collapsed",
};

/** A made-up VS Code theme, as if dropped into ~/.config/yaah/themes. */
const harbor = {
  name: "Harbor",
  type: "dark",
  colors: {
    "editor.background": "#0f1b24",
    "editor.foreground": "#d7e3ea",
    "sideBar.background": "#0b151c",
    "textLink.foreground": "#5cc8b5",
    descriptionForeground: "#7f95a3",
    "panel.border": "#1f3240",
  },
};

const dataDirs = [
  ["Chats", ".yaah/sessions", "Transcripts, restored at start."],
  ["Quick-chat folders", ".yaah/scratch", "Scratch folders for chats without a project."],
  ["Project context", ".yaah/projects", "Each project's brief and context folder."],
  ["Component library", ".yaah/components", "Components agents built, with history. yaah's own ship with the app."],
  ["Settings", ".config/yaah", "Agents, integrations, MCP servers, connections and these settings (secrets in 0600 files)."],
].map(([label, rel, about]) => ({ label, path: `${home}/${rel}`, about, exists: true }));

export function seedSettings() {
  return {
    appearance: "system" as Appearance,
    theme: { light: "yaah", dark: "yaah" },
    /** Your own tool-card rules, over the defaults. */
    cardRules: {} as Record<string, CardMode>,
    workspaceRoots: [ws],
    teachAgents: true,
  };
}

const routeLabels: Record<GuideRoute, string> = {
  mcp: "yaah-ui MCP server: instructions, the ui_guide tool, the skills as resources and prompts",
  acpSystemPrompt: "The guide in the system prompt (ACP systemPrompt, append)",
  firstPrompt: "The guide at the top of each chat's first message",
  claudeSystemPrompt: "The guide in Claude Code's system prompt (_meta.systemPrompt)",
  claudePlugin: "The skills as a Claude Code plugin (~/.yaah/agent-plugin)",
};

/** `agent_guide::plan`, for the mock's agents. */
function routes(preset: string, mcpHttp: boolean, systemPrompt: boolean, teach: boolean): GuideRoute[] {
  if (!mcpHttp) return [];
  if (!teach) return ["mcp"];
  const claude = preset === "claude";
  return ["mcp", systemPrompt ? "acpSystemPrompt" : claude ? "claudeSystemPrompt" : "firstPrompt", ...(claude ? (["claudePlugin"] as const) : [])];
}

function index(names: string[]): string {
  if (names.length === 0) return "none yet (see ui_catalog).";
  const shown = names.slice(0, 40).join(", ");
  return names.length > 40 ? `${shown} (+${names.length - 40} more, see ui_catalog).` : `${shown}.`;
}

export function settingsReplies({ state }: Mock): Replies {
  return {
    general_settings: (): GeneralSettings => ({
      appearance: state.appearance,
      theme: state.theme,
      toolCards: {
        rules: { ...cardDefaults, ...state.cardRules },
        defaults: Object.entries(cardDefaults).map(([key, mode]) => ({ key, mode })),
      },
      customThemes: [{ file: "harbor.json", label: "Harbor (sample drop-in)", type: "dark" }],
      workspaceRoots: state.workspaceRoots,
      version: "0.1.0",
      dataDirs,
      teachAgents: state.teachAgents,
    }),
    set_appearance: ({ appearance }: { appearance: Appearance }) => {
      state.appearance = appearance;
      return null;
    },
    set_theme: ({ light, dark }: { light: string; dark: string }) => {
      state.theme = { light, dark };
      return null;
    },
    read_custom_theme: () => harbor,
    set_tool_card: ({ key, mode }: { key: string; mode: CardMode | null }) => {
      const { [key]: _, ...rest } = state.cardRules;
      state.cardRules = mode ? { ...rest, [key]: mode } : rest;
      return null;
    },
    agent_guide: (): AgentGuide => {
      const names = index([...bundledComponents, ...state.localComponents].map((c) => c.name));
      const fill = (t: string) =>
        t.replace("{{components}}", names).replace("{{primitives}}", "(the primitive index, generated from ui-primitives.json)");
      const skill = (name: string, text: string) => ({
        name,
        description: /^description: (.*)$/m.exec(text)?.[1] ?? "",
        path: `${home}/.yaah/agent-skills/${name}/SKILL.md`,
        text: fill(text),
      });
      return {
        enabled: state.teachAgents,
        guide: fill(guideTemplate),
        skillsDir: `${home}/.yaah/agent-skills`,
        pluginDir: `${home}/.yaah/agent-plugin`,
        skills: [skill("yaah-ui", uiSkill), skill("yaah-components", componentsSkill)],
        agents: state.profiles.map((p) => ({
          id: p.id,
          label: p.label,
          known: !!p.report,
          routes: p.report
            ? routes(p.preset, p.report.mcpHttp, p.report.systemPrompt ?? false, state.teachAgents).map((id) => ({ id, label: routeLabels[id] }))
            : [],
        })),
      };
    },
    set_teach_agents: ({ enabled }: { enabled: boolean }) => {
      state.teachAgents = enabled;
      return null;
    },
    set_workspace_roots: ({ roots }: { roots: string[] }): string[] => (state.workspaceRoots = roots),
    reveal_data_dir: () => null,
  };
}
