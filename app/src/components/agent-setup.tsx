// The Settings dialog and the first-run screen. Each tab's code is in its own
// chunk, out of the main one; the dialog fetches them all when it opens (and the
// app when it's idle), so a first visit to a tab doesn't wait on a fallback.
import { startTransition, Suspense, useEffect, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AgentsProps, AgentTarget } from "@/components/settings/agents-settings";
import { TabSkeleton } from "@/components/settings/tab-skeleton";
import { preloadSettings, TAB_CODE } from "@/components/settings/tab-code";

const {
  general: GeneralSettings,
  agents: AgentsSettings,
  chat: ChatSettings,
  mcp: McpSettings,
  skills: SkillsSettings,
  components: LibrariesSettings,
  integrations: IntegrationsSettings,
  keyboard: KeyboardSettings,
} = TAB_CODE;

/** The Settings tabs, in order. */
const TABS = [
  { id: "general", label: "General", about: "Appearance, workspace folders and where yaah keeps its data." },
  { id: "agents", label: "Agents (ACP)", about: "yaah runs any agent that speaks the Agent Client Protocol (ACP)." },
  { id: "chat", label: "Chat", about: "How chats show what the agent is doing." },
  { id: "mcp", label: "MCP servers", about: "Tools you give every agent: yaah hands these servers to each chat's agent through ACP." },
  { id: "skills", label: "Skills", about: "Instructions and scripts agents load when a task calls for them. Install from GitHub in a click." },
  {
    id: "components",
    label: "Components",
    about: "Component libraries agents build UI from: yaah's own, yours, and ones you install from a git repo or a folder.",
  },
  {
    id: "integrations",
    label: "Integrations",
    about: "Services and databases yaah reads for you. Agents use them through live views and never see a token.",
  },
  { id: "keyboard", label: "Keyboard", about: "Shortcuts across the app." },
] as const;
export type SettingsTab = (typeof TABS)[number]["id"];

/** What the settings dialog opens on: an agent screen, an integration, or a tab. */
export type SettingsTarget = AgentTarget | { kind: "integrations"; service?: string } | { kind: "settings"; tab?: SettingsTab };

const tabOf = (t: SettingsTarget | null): SettingsTab =>
  !t ? "general" : t.kind === "settings" ? (t.tab ?? "general") : t.kind === "integrations" ? "integrations" : "agents";

type AgentProps = Omit<AgentsProps, "target">;

/** Settings: general, agents (ACP), chat, MCP servers, skills, component libraries, integrations and keyboard. */
export function AgentSetupDialog({ target, onClose, ...agentProps }: AgentProps & { target: SettingsTarget | null; onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(() => tabOf(target));
  const open = !!target;
  useEffect(() => {
    if (open) void preloadSettings();
  }, [open]);
  // A tab opens once its code is in (it nearly always is, see above), in a transition, so the
  // tab on screen stays until the next one can draw instead of flashing a skeleton.
  const pick = (id: SettingsTab) => {
    const code = TAB_CODE[id];
    if (code.loaded) return startTransition(() => setTab(id));
    code.preload().then(
      () => startTransition(() => setTab(id)),
      () => setTab(id),
    );
  };
  // Each new target (⌘K → MCP servers…, Log in → Edit agent) opens on its own tab.
  const [shownTarget, setShownTarget] = useState(target);
  if (target !== shownTarget) {
    setShownTarget(target);
    if (target) setTab(tabOf(target));
  }

  const agentTarget: AgentTarget = target?.kind === "add" || target?.kind === "manage" ? target : { kind: "manage" };
  const view = (id: SettingsTab): ReactNode => {
    switch (id) {
      case "general":
        return (
          <Scrolls>
            <GeneralSettings />
          </Scrolls>
        );
      case "agents":
        // A new target picks its agent afresh.
        return <AgentsSettings key={JSON.stringify(agentTarget)} target={agentTarget} {...agentProps} />;
      case "chat":
        return (
          <Scrolls>
            <ChatSettings />
          </Scrolls>
        );
      case "mcp":
        return <McpSettings />;
      case "skills":
        return <SkillsSettings />;
      case "components":
        return <LibrariesSettings />;
      case "integrations":
        return <IntegrationsSettings initial={target?.kind === "integrations" ? target.service : undefined} />;
      case "keyboard":
        return (
          <Scrolls>
            <KeyboardSettings />
          </Scrolls>
        );
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[min(46rem,92vh)] flex-col gap-0 p-0 sm:max-w-5xl">
        <Tabs value={tab} onValueChange={(v) => pick(v as SettingsTab)} className="min-h-0 flex-1 flex-col gap-0">
          <DialogHeader className="gap-3 border-b px-4 pt-4">
            <div className="flex flex-col gap-1 pr-8">
              <DialogTitle>Settings</DialogTitle>
              <DialogDescription>{TABS.find((t) => t.id === tab)?.about}</DialogDescription>
            </div>
            <TabsList variant="line" aria-label="Settings" className="w-full flex-wrap justify-start group-data-horizontal/tabs:h-auto">
              {TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id} className="h-8 flex-none px-3">
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </DialogHeader>
          {TABS.map((t) => (
            <TabsContent key={t.id} value={t.id} className="flex min-h-0 flex-col">
              <Suspense fallback={<TabSkeleton />}>{view(t.id)}</Suspense>
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function Scrolls({ children }: { children: ReactNode }) {
  return <ScrollArea className="min-h-0 flex-1">{children}</ScrollArea>;
}

/** First run: no agent configured yet. */
export function FirstRunSetup(props: AgentProps) {
  return (
    <main className="flex h-screen flex-1 flex-col bg-background">
      <header className="flex flex-col gap-1 border-b px-6 py-5">
        <h1 className="text-lg font-semibold tracking-tight">Set up an agent</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          yaah runs coding agents that speak the Agent Client Protocol. Pick one you have installed, test that it starts, and add it. You can add more
          later from ⌘K → Manage agents.
        </p>
      </header>
      <Suspense fallback={<TabSkeleton />}>
        <AgentsSettings target={{ kind: "add" }} {...props} />
      </Suspense>
    </main>
  );
}
