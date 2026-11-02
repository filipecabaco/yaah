// All of the mock's mutable state, built fresh by each `installBrowserMock()`.
import { seedAgents } from "./agents";
import { seedChats } from "./chats";
import { seedIntegrations } from "./integrations";
import { seedMcp } from "./mcp";
import { seedProjects } from "./projects";
import { seedSettings } from "./settings";
import { seedSkills } from "./skills";
import { seedSources } from "./sources";

export function createState({ firstRun }: { firstRun: boolean }) {
  return {
    ...seedProjects(),
    ...seedChats(),
    ...seedAgents(firstRun),
    ...seedSources(),
    ...seedIntegrations(),
    ...seedSettings(),
    ...seedSkills(),
    ...seedMcp(),
  };
}

export type State = ReturnType<typeof createState>;
