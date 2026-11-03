// The New project dialog: named, with repos, or started from a tracker item.
// Loaded on first use (it isn't needed at startup).
import { useState } from "react";
import { CircleDot, FolderGit2, FolderPlus, X } from "lucide-react";
import { AgentSelect } from "@/components/agent-choice";
import { ErrorText } from "@/components/error-text";
import { RepoPicker } from "@/components/repo-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { WorkItemPicker, type WorkItemPickerProps } from "@/components/work-item-picker";
import type { AgentProfile, NewProjectOptions, StartedProject, WorkItem } from "@/lib/api";
import { baseName, compactPath } from "@/lib/format";

export type NewProjectMode = "name" | "issue";

/** A new project: named, with repos, or started from a tracker item ("From an issue"). */
export function NewProjectDialog({
  open: isOpen,
  mode: openMode = "name",
  agents,
  agentId,
  onClose,
  onCreate,
  onStart,
  ...picker
}: {
  open: boolean;
  /** The mode it opens on. */
  mode?: NewProjectMode;
  agents: AgentProfile[];
  /** The agent it offers first: the one picked in the sidebar. */
  agentId: string;
  onClose: () => void;
  onCreate: (name: string, dirs: string[], options: NewProjectOptions) => Promise<void>;
  /** Starts from an item, its chat with `agentId`. */
  onStart: (item: WorkItem, agentId: string) => Promise<StartedProject>;
} & Omit<WorkItemPickerProps, "onDone" | "onStart">) {
  const [mode, setMode] = useState<NewProjectMode>(openMode);
  const [name, setName] = useState("");
  const [dirs, setDirs] = useState<string[]>([]);
  const [agent, setAgent] = useState(agentId);
  const [statement, setStatement] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [picking, setPicking] = useState(false);

  // Each time it opens: on the mode it was opened with, and the current agent.
  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setMode(openMode);
      setAgent(agentId);
    }
  }
  // An agent removed meanwhile: back to the current one.
  const chosen = agents.some((a) => a.id === agent) ? agent : agentId;

  function reset() {
    setName("");
    setDirs([]);
    setStatement("");
    setError(null);
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await onCreate(name, dirs, { agentId: chosen || undefined, statementOfWork: statement });
      reset();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const agentSelect = (label: string, className?: string) =>
    agents.length > 0 && <AgentSelect agents={agents} value={chosen} onChange={setAgent} label={label} className={className} />;

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && (reset(), onClose())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            {mode === "name"
              ? "A project groups the repos one piece of work spans. Chats run in the first repo and can work across the others."
              : "Start from an issue or a Linear project. The project follows it, its brief carries it, and a chat opens with the prompt drafted for you to send."}
          </DialogDescription>
        </DialogHeader>
        <Tabs value={mode} onValueChange={(v) => setMode(v as NewProjectMode)} className="min-w-0 gap-4">
          <TabsList variant="line" aria-label="Start the project" className="-mt-1">
            <TabsTrigger value="name" className="flex-none px-2">
              <FolderPlus /> Name and repos
            </TabsTrigger>
            <TabsTrigger value="issue" className="flex-none px-2">
              <CircleDot /> From an issue
            </TabsTrigger>
          </TabsList>
          <TabsContent value="name">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
              className="flex flex-col gap-4"
            >
              <div className="flex gap-2">
                <Input
                  autoFocus
                  aria-label="Project name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={dirs[0] ? `Name (defaults to “${baseName(dirs[0])}”)` : "Name"}
                  className="min-w-0 flex-1"
                />
                {agentSelect("Agent for the project's chats", "w-48 shrink-0")}
              </div>

              <div className="flex flex-col gap-1.5">
                {dirs.map((d, i) => (
                  <div key={d} className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
                    <span className="min-w-0 flex-1 truncate" title={d}>
                      {baseName(d)} <span className="font-mono text-xs text-muted-foreground">{compactPath(d)}</span>
                    </span>
                    {i === 0 && <Badge variant="secondary">working folder</Badge>}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setDirs(dirs.filter((x) => x !== d))}
                      title="Remove"
                      aria-label={`Remove ${baseName(d)}`}
                    >
                      <X />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setPicking(true)}>
                  <FolderGit2 /> Add repos
                </Button>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between">
                  <Label htmlFor="statement-of-work">Statement of work</Label>
                  <span className="text-xs text-muted-foreground">optional · Markdown</span>
                </div>
                <Textarea
                  id="statement-of-work"
                  aria-describedby="statement-of-work-hint"
                  value={statement}
                  onChange={(e) => setStatement(e.target.value)}
                  onKeyDown={(e) => {
                    // ⌘/Ctrl+Enter creates the project; Enter is a new line.
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={4}
                  placeholder={"Goal: …\nIn scope: …\nOut of scope: …\nDone when: …"}
                  className="max-h-60 min-h-24 font-mono text-xs"
                />
                <p id="statement-of-work-hint" className="text-xs text-muted-foreground">
                  What's the goal, what's in and out of scope, and what “done” means. It goes into the project's brief, which every chat starts from.
                </p>
              </div>

              <ErrorText error={error} className="text-sm whitespace-pre-wrap" />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => (reset(), onClose())}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || (!name.trim() && dirs.length === 0)}>
                  Create project
                </Button>
              </DialogFooter>
            </form>
            {/* Outside the form: React bubbles its events (a submit, Enter) through the portal. */}
            <RepoPicker
              open={picking}
              onClose={() => setPicking(false)}
              exclude={dirs}
              onAdd={(picked) => setDirs((prev) => [...prev, ...picked.filter((d) => !prev.includes(d))])}
            />
          </TabsContent>
          <TabsContent value="issue" className="flex min-w-0 flex-col gap-3">
            {agents.length > 0 && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>Its chat runs with</span>
                {agentSelect("Agent for the project's chats", "w-56")}
              </div>
            )}
            <WorkItemPicker {...picker} onStart={(item) => onStart(item, chosen)} onDone={() => (reset(), onClose())} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
