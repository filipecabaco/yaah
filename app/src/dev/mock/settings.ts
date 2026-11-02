// Settings → General: appearance, themes (with one custom drop-in, "harbor"),
// tool-card rules, workspace folders and data folders.
import type { Appearance, GeneralSettings } from "@/lib/api";
import { home, ws, type Mock, type Replies } from "./context";

type CardMode = GeneralSettings["toolCards"]["rules"][string];

const cardDefaults: Record<string, CardMode> = {
  ToolSearch: "collapsed",
  "Load skill": "collapsed",
  Skill: "collapsed",
  TodoWrite: "collapsed",
  "mcp__yaah-ui": "collapsed",
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
  };
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
    set_workspace_roots: ({ roots }: { roots: string[] }): string[] => (state.workspaceRoots = roots),
    reveal_data_dir: () => null,
  };
}
