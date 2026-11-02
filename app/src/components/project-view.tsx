import { useEffect, useRef, useState } from "react";
import { FolderGit2, Loader2, MessageSquarePlus, Trash2, X } from "lucide-react";
import { ChatMenu } from "@/components/menus";
import { RepoPicker } from "@/components/repo-picker";
import { Hint } from "@/components/shortcuts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, PROJECT_STATUSES, canChat, type AgentProfile, type Project, type ProjectStatus, type SessionInfo } from "@/lib/api";
import { baseName, compactPath } from "@/lib/format";
import { ErrorText } from "@/components/error-text";

type Props = {
  project: Project;
  chats: SessionInfo[];
  account: AgentProfile | undefined;
  onChange: (p: Project) => void;
  onDelete: (id: string) => Promise<void>;
  onOpenChat: (id: string) => void;
  onNewChat: (projectId: string) => Promise<void>;
  onLogin: (agent: AgentProfile) => void;
  /** Set by the sidebar's Delete… item: show the delete confirmation. */
  askDelete?: boolean;
  onAskDeleteSeen?: () => void;
};

export function ProjectView({ project, chats, account, onChange, onDelete, onOpenChat, onNewChat, onLogin, askDelete, onAskDeleteSeen }: Props) {
  const [name, setName] = useState(project.name);
  const [brief, setBrief] = useState<string | null>(null);
  const [briefSaved, setBriefSaved] = useState(true);
  const [starting, setStarting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(!!askDelete);
  const [error, setError] = useState<unknown>(null);
  const deleteSection = useRef<HTMLElement>(null);

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
  }, [project.id]);

  useEffect(() => {
    if (!askDelete) return;
    deleteSection.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    onAskDeleteSeen?.();
  }, [askDelete, onAskDeleteSeen]);

  /** Runs a change, showing what went wrong if it fails. */
  const run = (f: () => Promise<unknown>) => {
    setError(null);
    f().catch(setError);
  };

  function rename() {
    if (name.trim() && name.trim() !== project.name) run(async () => onChange(await api.renameProject(project.id, name)));
  }

  function saveBrief() {
    if (brief == null || briefSaved) return;
    run(async () => {
      await api.writeBrief(project.id, brief);
      setBriefSaved(true);
    });
  }

  async function newChat() {
    setStarting(true);
    setError(null);
    try {
      await onNewChat(project.id);
    } catch (e) {
      setError(e);
    } finally {
      setStarting(false);
    }
  }

  return (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-8">
        <header className="flex items-center gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="h-9 border-transparent px-1 text-lg font-semibold shadow-none hover:border-input focus-visible:border-input"
            aria-label="Project name"
          />
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

        <ErrorText error={error} className="-mt-4 text-sm whitespace-pre-wrap" />

        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">Chats</h2>
            <Hint label="New chat" shortcut="newChat">
              <Button size="sm" onClick={() => void newChat()} disabled={starting || !canChat(account)}>
                {starting ? <Loader2 className="animate-spin" /> : <MessageSquarePlus />}
                {starting ? "Starting agent…" : `New chat as ${account?.label ?? "…"}`}
              </Button>
            </Hint>
          </div>
          {account?.loggedIn === false && (
            <p className="text-sm text-muted-foreground">
              “{account.label}” isn't logged in.{" "}
              <Button variant="link" className="h-auto p-0" onClick={() => onLogin(account)}>
                Log in
              </Button>{" "}
              or pick another agent in the sidebar.
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
