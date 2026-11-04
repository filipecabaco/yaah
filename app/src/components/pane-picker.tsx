// What a new split pane opens on: start a chat (with an agent) or a project, or
// open any chat or project, through one search ranked like the ⌘K palette's.
import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { FolderGit2, FolderOpen, FolderPlus, GitCompare, History, Loader2, MessageSquare, MessageSquarePlus, SquareTerminal, X } from "lucide-react";
import { TerminalFolders } from "@/components/terminal/terminal-folders";
import { AgentSelect } from "@/components/agent-choice";
import { ResumeSession } from "@/components/resume-session";
import { Badge } from "@/components/ui/badge";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { mayListSessions, type AgentProfile, type AgentSession, type Project, type SessionInfo } from "@/lib/api";
import { rankTop } from "@/lib/fuzzy";
import type { Selection } from "@/lib/layout";
import { baseName, compactPath } from "@/lib/format";
import { formatKeys, SHORTCUTS } from "@/lib/shortcuts";

// The "Repositories" step: loaded when it's first wanted.
const RepoPicker = lazy(() => import("@/components/repo-picker").then((m) => ({ default: m.RepoPicker })));

type Entry = { id: string; icon: ReactNode; label: string; detail?: string; keys?: string; run: () => void };

/** Listed before anything is typed; typing searches all of them. */
const RECENT = 6;
const LIMIT = 30;

export function PanePicker({
  agents,
  agentId,
  chats,
  projects,
  autoFocus,
  onNewChat,
  onNewProject,
  onOpen,
  onClose,
  onResume,
  onNewTerminal,
  onNewDiff,
}: {
  agents: AgentProfile[];
  /** The agent a new chat starts with until another is picked here (the sidebar's). */
  agentId: string;
  /** In sidebar order. */
  chats: SessionInfo[];
  projects: Project[];
  autoFocus: boolean;
  /** `extraDirs`: the repos picked in the optional "Repositories" step (docs/research/chat-repos-contract.md). */
  onNewChat: (agentId: string, extraDirs: string[]) => void;
  onNewProject: () => void;
  onOpen: (s: Selection) => void;
  /** Esc on an empty search: close the pane. */
  onClose: () => void;
  /** "Resume a session…": bring one of an agent's own sessions in and open it here. */
  onResume?: (accountId: string, session: AgentSession) => Promise<unknown>;
  /** "New terminal…": a shell in this pane, in the folder picked (`undefined`: the default one). */
  onNewTerminal?: (cwd: string | undefined) => void;
  /** "Open diff…": the changes of the repository in the folder picked, in this pane. */
  onNewDiff?: (cwd: string) => void;
}) {
  // Showing the "Open diff…" folder step.
  const [diffFolder, setDiffFolder] = useState(false);
  // Showing the "New terminal…" folder step instead of the picker's own list.
  const [terminalFolder, setTerminalFolder] = useState(false);
  const [search, setSearch] = useState("");
  // Showing the "Resume a session…" steps instead of the picker's own list.
  const [resuming, setResuming] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const agent = agents.find((a) => a.id === picked) ?? agents.find((a) => a.id === agentId) ?? agents[0];
  const [active, setActive] = useState<{ id: string; query: string } | null>(null);
  // Repos the new chat starts with, besides its own folder; picked with the RepoPicker.
  const [repos, setRepos] = useState<string[]>([]);
  const [choosing, setChoosing] = useState(false);
  const [wanted, setWanted] = useState(false);
  const chooseRepos = () => {
    setWanted(true);
    setChoosing(true);
  };
  const reposDetail = repos.length === 1 ? baseName(repos[0]) : repos.length ? `${repos.length} repos` : null;

  const actions: Entry[] = [
    {
      id: "new-chat",
      icon: <MessageSquarePlus />,
      label: "New chat",
      detail: agent ? [`with ${agent.label}`, reposDetail].filter(Boolean).join(" · ") : undefined,
      run: () => agent && onNewChat(agent.id, repos),
    },
    {
      id: "repos",
      icon: <FolderGit2 />,
      label: "Add repositories…",
      detail: reposDetail ?? "optional",
      run: chooseRepos,
    },
    { id: "new-project", icon: <FolderPlus />, label: "New project…", keys: formatKeys(SHORTCUTS.newProject.keys), run: onNewProject },
    ...(onNewTerminal
      ? [{ id: "new-terminal", icon: <SquareTerminal />, label: "New terminal…", detail: "pick a folder", run: () => setTerminalFolder(true) }]
      : []),
    ...(onNewDiff
      ? [{ id: "new-diff", icon: <GitCompare />, label: "Open diff…", detail: "changes of a git repository", run: () => setDiffFolder(true) }]
      : []),
    ...(onResume && agents.some(mayListSessions)
      ? [{ id: "resume", icon: <History />, label: "Resume a session…", detail: "started in an agent's CLI", run: () => setResuming(true) }]
      : []),
  ];
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const chatEntries = useMemo(
    () =>
      chats.map((c): Entry => ({
        id: `chat-${c.sessionId}`,
        icon: c.running ? <Loader2 className="animate-spin" /> : <MessageSquare />,
        label: c.title,
        detail: c.projectId ? (projectName.get(c.projectId) ?? "") : "quick chat",
        run: () => onOpen({ kind: "chat", id: c.sessionId }),
      })),
    [chats, projectName, onOpen],
  );
  const projectEntries = useMemo(
    () =>
      projects.map((p): Entry => ({
        id: `project-${p.id}`,
        icon: <FolderOpen />,
        label: p.name,
        detail: p.status === "ongoing" ? undefined : p.status,
        run: () => onOpen({ kind: "project", id: p.id }),
      })),
    [projects, onOpen],
  );

  const query = search.trim();
  const groups: { heading: string; list: Entry[] }[] = query
    ? [{ heading: "Results", list: rankTop([...actions, ...chatEntries, ...projectEntries], query, (e) => [e.label, e.detail], LIMIT).shown }]
    : [
        { heading: "Start", list: actions },
        { heading: "Recent chats", list: chatEntries.slice(0, RECENT) },
        { heading: "Projects", list: projectEntries.slice(0, RECENT) },
      ].filter((g) => g.list.length > 0);
  const all = groups.flatMap((g) => g.list);
  // Each search starts on its best match, as in the palette.
  const value = active?.query === query && all.some((e) => e.id === active.id) ? active.id : (all[0]?.id ?? "");

  if (terminalFolder && onNewTerminal) {
    return (
      <div className="[container-type:size] flex min-w-0 flex-1 justify-center overflow-y-auto px-4 py-8">
        <div className="mt-[max(0px,calc(12cqh-2rem))] flex h-fit w-full max-w-md flex-col gap-3">
          <div className="flex flex-col gap-1 px-1">
            <h2 className="text-sm font-medium">New terminal</h2>
            <p className="text-xs text-muted-foreground">A shell in this pane. Where should it start?</p>
          </div>
          <TerminalFolders chats={chats} projects={projects} onPick={onNewTerminal} onBack={() => setTerminalFolder(false)} />
        </div>
      </div>
    );
  }

  if (diffFolder && onNewDiff) {
    return (
      <div className="[container-type:size] flex min-w-0 flex-1 justify-center overflow-y-auto px-4 py-8">
        <div className="mt-[max(0px,calc(12cqh-2rem))] flex h-fit w-full max-w-md flex-col gap-3">
          <div className="flex flex-col gap-1 px-1">
            <h2 className="text-sm font-medium">Open a diff</h2>
            <p className="text-xs text-muted-foreground">The changes of a git repository, in this pane. Which folder?</p>
          </div>
          <TerminalFolders
            purpose="diff"
            chats={chats}
            projects={projects}
            onPick={(dir) => dir && onNewDiff(dir)}
            onBack={() => setDiffFolder(false)}
          />
        </div>
      </div>
    );
  }

  if (resuming && onResume) {
    return (
      <div className="[container-type:size] flex min-w-0 flex-1 justify-center overflow-y-auto px-4 py-8">
        <div className="mt-[max(0px,calc(12cqh-2rem))] flex h-fit w-full max-w-lg flex-col gap-3">
          <div className="flex flex-col gap-1 px-1">
            <h2 className="text-sm font-medium">Resume a session</h2>
            <p className="text-xs text-muted-foreground">Carry on, in this pane, with a session you started in an agent's CLI.</p>
          </div>
          <ResumeSession agents={agents} inPane onResume={onResume} onBack={() => setResuming(false)} />
        </div>
      </div>
    );
  }

  return (
    // Its top gap follows the pane's own height (a pane below another is short), not the window's.
    <div className="[container-type:size] flex min-w-0 flex-1 justify-center overflow-y-auto px-4 py-8">
      <div className="mt-[max(0px,calc(12cqh-2rem))] flex h-fit w-full max-w-md flex-col gap-3">
        <div className="flex flex-col gap-1 px-1">
          <h2 className="text-sm font-medium">Open in this pane</h2>
          <p className="text-xs text-muted-foreground">Start something new, or find a chat or project.</p>
        </div>
        <Command
          shouldFilter={false}
          vimBindings={false}
          value={value}
          onValueChange={(id) => setActive({ id, query })}
          className="h-auto rounded-xl! border shadow-xs"
          // cmdk names its input after this label.
          label="Search chats and projects"
        >
          <CommandInput
            data-pane-autofocus
            autoFocus={autoFocus}
            value={search}
            onValueChange={setSearch}
            placeholder="Search chats and projects…"
            onKeyDown={(e) => {
              if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              e.stopPropagation();
              if (search) setSearch("");
              else onClose();
            }}
          />
          <CommandList className="max-h-[50vh]">
            {all.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches.</p>}
            {groups.map((g) => (
              <CommandGroup key={g.heading} heading={g.heading}>
                {g.list.map((e) => (
                  <CommandItem key={e.id} value={e.id} onSelect={e.run}>
                    {e.icon}
                    <span className="truncate">{e.label}</span>
                    {e.detail && (
                      // In a narrow pane the detail gives way before the label does.
                      <Badge variant="outline" className="max-w-40 min-w-12 shrink-[4] justify-start font-normal text-muted-foreground">
                        <span className="truncate">{e.detail}</span>
                      </Badge>
                    )}
                    {e.keys && <CommandShortcut>{e.keys}</CommandShortcut>}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          <footer className="flex items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
            <span>
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
            </span>
            <span>
              <Kbd>↵</Kbd> open
            </span>
            <span className="ml-auto">
              <Kbd>Esc</Kbd> {search ? "clear" : "close pane"}
            </span>
          </footer>
        </Command>
        {agents.length > 1 && agent && (
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <span className="shrink-0">New chats here start with</span>
            <AgentSelect
              agents={agents}
              value={agent.id}
              onChange={setPicked}
              label="Agent for a new chat in this pane"
              size="sm"
              className="min-w-0 flex-1"
            />
          </div>
        )}
        {repos.length > 0 && (
          <div className="flex flex-col gap-1.5 px-1 text-xs text-muted-foreground">
            <span>The new chat also gets</span>
            <ul className="flex flex-wrap gap-1.5" aria-label="Repositories for the new chat">
              {repos.map((r) => (
                <li key={r}>
                  <Badge variant="outline" className="gap-1 pr-0.5 font-normal" title={compactPath(r)}>
                    <FolderGit2 className="size-3 text-muted-foreground" />
                    {baseName(r)}
                    <button
                      type="button"
                      className="grid size-4 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                      onClick={() => setRepos((list) => list.filter((x) => x !== r))}
                      aria-label={`Remove ${baseName(r)}`}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {wanted && (
        <Suspense>
          <RepoPicker
            open={choosing}
            onClose={() => setChoosing(false)}
            exclude={repos}
            onAdd={(dirs) => {
              setRepos((list) => [...new Set([...list, ...dirs])]);
              setChoosing(false);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
