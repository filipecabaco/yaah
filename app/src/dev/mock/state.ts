// All of the mock's mutable state, built fresh by each `installBrowserMock()`.
import { seedAgents } from "./agents";
import { seedChats } from "./chats";
import { seedIntegrations } from "./integrations";
import { seedLibrary } from "./library";
import { seedMcp } from "./mcp";
import { seedProjects } from "./projects";
import { seedSettings } from "./settings";
import { seedSkills } from "./skills";
import { seedSources } from "./sources";
import { linkSeededProjects } from "./work-items";

export function createState({ firstRun }: { firstRun: boolean }) {
  const state = {
    ...seedProjects(),
    ...seedChats(),
    ...seedAgents(firstRun),
    ...seedSources(),
    ...seedIntegrations(),
    ...seedLibrary(),
    ...seedSettings(),
    ...seedSkills(),
    ...seedMcp(),
  };
  linkSeededProjects(state);
  return state;
}

export type State = ReturnType<typeof createState>;
