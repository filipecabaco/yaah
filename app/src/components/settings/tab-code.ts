// Each Settings tab's code, in a chunk of its own. The dialog fetches them all when
// it opens, and the app when it's idle, so a first visit to a tab doesn't wait.
import { preloadable, preloadAll } from "@/lib/preload";

const GeneralSettings = preloadable(() => import("@/components/settings/general-settings").then((m) => m.GeneralSettings));
const AgentsSettings = preloadable(() => import("@/components/settings/agents-settings").then((m) => m.AgentsSettings));
const ProvidersSettings = preloadable(() => import("@/components/settings/providers-settings").then((m) => m.ProvidersSettings));
const ChatSettings = preloadable(() => import("@/components/settings/chat-settings").then((m) => m.ChatSettings));
const McpSettings = preloadable(() => import("@/components/settings/mcp-settings").then((m) => m.McpSettings));
const SkillsSettings = preloadable(() => import("@/components/settings/skills-settings").then((m) => m.SkillsSettings));
const LibrariesSettings = preloadable(() => import("@/components/settings/libraries-settings").then((m) => m.LibrariesSettings));
const IntegrationsSettings = preloadable(() => import("@/components/settings/integrations-settings").then((m) => m.IntegrationsSettings));
const KeyboardSettings = preloadable(() => import("@/components/settings/keyboard-settings").then((m) => m.KeyboardSettings));

/** Each tab's code, by tab. */
export const TAB_CODE = {
  general: GeneralSettings,
  agents: AgentsSettings,
  providers: ProvidersSettings,
  chat: ChatSettings,
  mcp: McpSettings,
  skills: SkillsSettings,
  components: LibrariesSettings,
  integrations: IntegrationsSettings,
  keyboard: KeyboardSettings,
} as const;

/** Fetch every Settings tab's code (on open, or when the app is idle). */
export const preloadSettings = () => preloadAll(Object.values(TAB_CODE));
