import { useEffect, useRef, useState } from "react";
import { ChevronDown, FolderGit2, Loader2, MessageSquarePlus, ShieldCheck, Trash2, X } from "lucide-react";
import { AgentMenu, AgentSelect } from "@/components/agent-choice";
import { ChatMenu } from "@/components/menus";
import { RepoPicker } from "@/components/repo-picker";
import { Hint } from "@/components/shortcuts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, PROJECT_STATUSES, canChat, needsProviderFix, type AgentProfile, type Project, type ProjectStatus, type SessionInfo } from "@/lib/api";
import { baseName, compactPath } from "@/lib/format";
import { ErrorText } from "@/components/error-text";
import { ProjectLinkPill, ProjectLinkSection } from "@/components/project-link";

type Props = {
  project: Project;
  chats: SessionInfo[];
  agents: AgentProfile[];
  /** The agent its new chats start with: its own, else the sidebar's. */
  account: AgentProfile | undefined;
  onChange: (p: Project) => void;
  onDelete: (id: string) => Promise<void>;
  onOpenChat: (id: string) => void;
  /** A chat in the project, with `agentId` when the user picked one for it. */
  onNewChat: (projectId: string, agentId?: string) => Promise<unknown>;
  onLogin: (agent: AgentProfile) => void;
  /** Set by the sidebar's Delete… item: show the delete confirmation. */
  askDelete?: boolean;
  onAskDeleteSeen?: () => void;
  /** Set by the sidebar's Rename…: focus the name to edit it. */
  askRename?: boolean;
  onAskRenameSeen?: () => void;
  /** Something to know about this project right now (a chat that didn't open when it was started from an issue). */
  notice?: string;
};

export function ProjectView({
  project,
  chats,
  agents,
  account,
  onChange,
  onDelete,
  onOpenChat,
  onNewChat,
  onLogin,
  askDelete,
  onAskDeleteSeen,
  askRename,
  onAskRenameSeen,
  notice,
}: Props) {
  const [name, setName] = useState(project.name);
  const [brief, setBrief] = useState<string | null>(null);
  const [briefSaved, setBriefSaved] = useState(true);
  /** Bumped when Rust rewrote the brief (a refresh or unlink), to read it again. */
  const [briefVersion, setBriefVersion] = useState(0);
  const [starting, setStarting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(!!askDelete);
  const [error, setError] = useState<unknown>(null);
  const deleteSection = useRef<HTMLElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  // Another project: start over. A rename from elsewhere: show the new name.
  const [shown, setShown] = useState({ id: project.id, name: project.name, askDelete });
  if (project.id !== shown.id || project.name !== shown.name || askDelete !== shown.askDelete) {
    setShown({ id: project.id, name: project.name, askDelete });
    if (project.id !== shown.id || project.name !== shown.name) setName(project.name);
    if (project.id !== shown.id) {
      setConfirmDelete(false);
      setError(null);
      setBrief(null);
      setBriefSaved(true);
    }
    // Set by the sidebar's Delete…, after the reset so it survives a project switch.
    if (askDelete && !shown.askDelete) setConfirmDelete(true);
  }

  useEffect(() => {
    let live = true;
    api.readBrief(project.id).then((t) => {
      if (!live) return;
      setBrief(t);
      setBriefSaved(true);
    }, setError);
    return () => {
      live = false;
    };
  }, [project.id, briefVersion]);

  useEffect(() => {
    if (!askDelete) return;
    deleteSection.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    onAskDeleteSeen?.();
  }, [askDelete, onAskDeleteSeen]);

  useEffect(() => {
    if (!askRename) return;
    // After the menu that asked has closed and handed focus back.
    const t = setTimeout(() => {
      nameInput.current?.focus();
      nameInput.current?.select();
      onAskRenameSeen?.();
    });
    return () => clearTimeout(t);
  }, [askRename, onAskRenameSeen]);

  /** Runs a change, showing what went wrong if it fails. */
  const run = (f: () => Promise<unknown>) => {
    setError(null);
    f().catch(setError);
  };

  function rename() {
    if (name.trim() && name.trim() !== project.name) run(async () => onChange(await api.renameProject(project.id, name)));
  }

  /** Writes unsaved brief edits (also before Rust rewrites the brief's issue block). */
  async function flushBrief() {
    if (brief == null || briefSaved) return;
    await api.writeBrief(project.id, brief);
    setBriefSaved(true);
  }

  function saveBrief() {
    run(flushBrief);
  }

  async function newChat(agentId?: string) {
    setStarting(true);
    setError(null);
    try {
      await onNewChat(project.id, agentId);
    } catch (e) {
      setError(e);
    } finally {
      setStarting(false);
    }
  }

  return (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-8">
        <header className="flex flex-wrap items-center gap-3">
          {/* In a narrow pane the name keeps its room and the selects wrap below it. */}
          <Input
            ref={nameInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="h-9 min-w-48 flex-1 border-transparent px-1 text-lg font-semibold shadow-none hover:border-input focus-visible:border-input"
            aria-label="Project name"
          />
          {agents.length > 0 && (
            <AgentSelect
              agents={agents}
              value={account?.id ?? ""}
              onChange={(id) => run(async () => onChange(await api.setProjectAgent(project.id, id)))}
              label="Agent for new chats in this project"
              className="w-44 shrink-0"
            />
          )}
          <Select value={project.status} onValueChange={(s) => run(async () => onChange(await api.setProjectStatus(project.id, s as ProjectStatus)))}>
            <SelectTrigger className="w-32 shrink-0" aria-label="Project status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROJECT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </header>

        {project.link && (
          <div className="-mt-6 flex min-w-0 px-1">
            <ProjectLinkPill link={project.link} />
          </div>
        )}

        <ErrorText error={error} className="-mt-4 text-sm whitespace-pre-wrap" />
        <ErrorText error={notice} className="-mt-4 text-sm whitespace-pre-wrap" />

        {project.link && (
          <ProjectLinkSection
            key={project.id}
            project={{ ...project, link: project.link }}
            onChange={onChange}
            beforeBriefChange={flushBrief}
            onBriefChanged={() => setBriefVersion((v) => v + 1)}
          />
        )}

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Chats</h2>
            <div className="flex">
              <Hint label="New chat" shortcut="newChat">
                <Button
                  size="sm"
                  className={agents.length > 1 ? "rounded-r-none" : undefined}
                  onClick={() => void newChat()}
                  disabled={starting || !canChat(account)}
                >
                  {starting ? <Loader2 className="animate-spin" /> : <MessageSquarePlus />}
                  {starting ? "Starting agent…" : `New chat as ${account?.label ?? "…"}`}
                </Button>
              </Hint>
              {/* One chat with another agent; the project keeps its own. */}
              {agents.length > 1 && (
                <AgentMenu
                  agents={agents}
                  heading="New chat with…"
                  current={account?.id}
                  currentHint="project's"
                  align="end"
                  onPick={(id) => {
                    const a = agents.find((x) => x.id === id);
                    if (a && !canChat(a)) onLogin(a);
                    else void newChat(id);
                  }}
                >
                  <Button size="sm" className="rounded-l-none border-l-primary-foreground/20 px-1.5" disabled={starting} aria-label="New chat with…">
                    <ChevronDown />
                  </Button>
                </AgentMenu>
              )}
            </div>
          </div>
          {account?.loggedIn === false && (
            <p className="text-sm text-muted-foreground">
              {needsProviderFix(account) ? `“${account.label}”'s model provider failed its check. ` : `“${account.label}” isn't logged in. `}
              <Button variant="link" className="h-auto p-0" onClick={() => onLogin(account)}>
                {needsProviderFix(account) ? "Fix in Settings → Model providers" : "Log in"}
              </Button>{" "}
              or pick another agent for the project above.
            </p>
          )}
          {chats.length === 0 ? (
            <p className="text-sm text-muted-foreground">No chats in this project yet.</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {chats.map((c) => (
                <li key={c.sessionId}>
                  <ChatMenu chat={c} onOpen={() => onOpenChat(c.sessionId)}>
                    <button
                      onClick={() => onOpenChat(c.sessionId)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted data-[state=open]:bg-muted"
                    >
                      <span className="min-w-0 flex-1 truncate">{c.title}</span>
                      {c.running && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                      <Badge variant="outline">{c.accountId}</Badge>
                    </button>
                  </ChatMenu>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Repos</h2>
          {project.dirs.length === 0 && (
            <p className="text-sm text-muted-foreground">No repos yet. Chats will run in the project's own folder until you add one.</p>
          )}
          {project.dirs.map((d, i) => (
            <div key={d} className="flex items-center gap-2 rounded-md border px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-sm" title={d}>
                {baseName(d)} <span className="font-mono text-xs text-muted-foreground">{compactPath(d)}</span>
              </span>
              {i === 0 && <Badge variant="secondary">working folder</Badge>}
              <Button
                variant="ghost"
                size="icon-xs"
                title="Remove from project"
                aria-label={`Remove ${baseName(d)} from project`}
                onClick={() => run(async () => onChange(await api.removeProjectDir(project.id, d)))}
              >
                <X />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" className="self-start" onClick={() => setPicking(true)}>
            <FolderGit2 /> Add repos
          </Button>
          <p className="text-xs text-muted-foreground">Chats run in the first repo and can work across the rest. Changes apply to new chats.</p>
          <RepoPicker
            open={picking}
            onClose={() => setPicking(false)}
            exclude={project.dirs}
            onAdd={async (dirs) => onChange(await api.addProjectDirs(project.id, dirs))}
          />
        </section>

        <section className="flex flex-col gap-2" aria-labelledby="project-trusted">
          <h2 id="project-trusted" className="text-sm font-medium">
            Trusted MCP servers
          </h2>
          {(project.trustedMcpServers ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None. On a permission request for an MCP tool, “Always allow tools from … in this project” adds its server here.
            </p>
          ) : (
            (project.trustedMcpServers ?? []).map((s) => (
              <div key={s} className="flex items-center gap-2 rounded-md border px-3 py-1.5">
                <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={s}>
                  {s}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Stop trusting"
                  aria-label={`Stop trusting ${s}`}
                  onClick={() => run(async () => onChange(await api.untrustProjectMcpServer(project.id, s)))}
                >
                  <X />
                </Button>
              </div>
            ))
          )}
          <p className="text-xs text-muted-foreground">
            The project&apos;s chats run every tool of these servers without asking, including ones that change things. Other tools still ask.
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 id="project-brief" className="text-sm font-medium">
              Brief
            </h2>
            <span className="text-xs text-muted-foreground">{briefSaved ? "Saved" : "Unsaved"}</span>
          </div>
          <Textarea
            aria-labelledby="project-brief"
            value={brief ?? ""}
            disabled={brief == null}
            onChange={(e) => {
              setBrief(e.target.value);
              setBriefSaved(false);
            }}
            onBlur={saveBrief}
            placeholder="What is this project about? Goals, constraints, links…"
            className="min-h-40 font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            Attached to the first message of every new chat. Stored in <code>{compactPath(project.contextDir)}/project.md</code>.
          </p>
        </section>

        <section ref={deleteSection} className="flex items-center gap-2 border-t pt-6">
          {confirmDelete ? (
            <>
              <span className="text-sm">Delete “{project.name}” and its brief? Your folders are not touched.</span>
              <Button variant="destructive" size="sm" onClick={() => run(() => onDelete(project.id))}>
                Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setConfirmDelete(true)}>
              <Trash2 /> Delete project
            </Button>
          )}
        </section>
      </div>
    </main>
  );
}
