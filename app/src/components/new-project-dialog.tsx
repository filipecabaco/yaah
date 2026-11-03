// The New project dialog: named, with repos, or started from a tracker item.
// Loaded on first use (it isn't needed at startup).
import { useState } from "react";
import { CircleDot, FolderGit2, FolderPlus, X } from "lucide-react";
import { ErrorText } from "@/components/error-text";
import { RepoPicker } from "@/components/repo-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WorkItemPicker, type WorkItemPickerProps } from "@/components/work-item-picker";
import { baseName, compactPath } from "@/lib/format";

export type NewProjectMode = "name" | "issue";

/** A new project: named, with repos, or started from a tracker item ("From an issue"). */
export function NewProjectDialog({
  open: isOpen,
  mode: openMode = "name",
  onClose,
  onCreate,
  ...picker
}: {
  open: boolean;
  /** The mode it opens on. */
  mode?: NewProjectMode;
  onClose: () => void;
  onCreate: (name: string, dirs: string[]) => Promise<void>;
} & Omit<WorkItemPickerProps, "onDone">) {
  const [mode, setMode] = useState<NewProjectMode>(openMode);
  const [name, setName] = useState("");
  const [dirs, setDirs] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [picking, setPicking] = useState(false);

  // Each time it opens: on the mode it was opened with.
  const [wasOpen, setWasOpen] = useState(false);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setMode(openMode);
  }

  function reset() {
    setName("");
    setDirs([]);
    setError(null);
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await onCreate(name, dirs);
      reset();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

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
              <Input
                autoFocus
                aria-label="Project name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={dirs[0] ? `Name (defaults to “${baseName(dirs[0])}”)` : "Name"}
              />

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
              <RepoPicker
                open={picking}
                onClose={() => setPicking(false)}
                exclude={dirs}
                onAdd={(picked) => setDirs((prev) => [...prev, ...picked.filter((d) => !prev.includes(d))])}
              />

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
          </TabsContent>
          <TabsContent value="issue" className="min-w-0">
            <WorkItemPicker {...picker} onDone={() => (reset(), onClose())} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
