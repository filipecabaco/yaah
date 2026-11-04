// "New terminal…" in a pane picker: which folder the shell starts in. A project's
// repos, a chat's folder, the default (the last folder a terminal opened in, or
// home), or any folder through the system's folder picker.
import { useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, FolderGit2, FolderOpen, FolderSearch, House, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import type { Project, SessionInfo } from "@/lib/api";
import { baseName, compactPath } from "@/lib/format";
import { rankTop } from "@/lib/fuzzy";

type Folder = { id: string; icon: React.ReactNode; label: string; detail?: string; path?: string; browse?: boolean };

/** Folders listed before anything is typed, per group. */
const SHOWN = 8;

/** Every folder a project or chat works in, once each, projects first. */
function knownFolders(chats: SessionInfo[], projects: Project[]): Folder[] {
  const seen = new Set<string>();
  const out: Folder[] = [];
  const add = (f: Folder) => {
    if (!f.path || seen.has(f.path)) return;
    seen.add(f.path);
    out.push(f);
  };
  for (const p of projects)
    for (const d of p.dirs) add({ id: `dir-${p.id}-${d}`, icon: <FolderGit2 />, label: baseName(d), detail: p.name, path: d });
  for (const c of chats) add({ id: `chat-${c.sessionId}`, icon: <MessageSquare />, label: baseName(c.cwd), detail: c.title, path: c.cwd });
  return out;
}

export function TerminalFolders({
  chats,
  projects,
  onPick,
  onBack,
  purpose = "terminal",
}: {
  chats: SessionInfo[];
  projects: Project[];
  /** `undefined`: the default folder. */
  onPick: (cwd: string | undefined) => void;
  onBack: () => void;
  /** What the folder is for: a terminal's start (with the default folder as a choice), or a diff to read. */
  purpose?: "terminal" | "diff";
}) {
  const [search, setSearch] = useState("");
  const folders = useMemo(() => knownFolders(chats, projects), [chats, projects]);
  const diff = purpose === "diff";
  const fixed: Folder[] = [
    ...(diff ? [] : [{ id: "default", icon: <House />, label: "Default folder", detail: "the last one used, or home" }]),
    { id: "browse", icon: <FolderSearch />, label: "Choose a folder…", browse: true },
  ];
  const query = search.trim();
  const list = query
    ? rankTop([...fixed, ...folders], query, (f) => [f.label, f.detail, f.path], 30).shown
    : [...fixed, ...folders.slice(0, SHOWN * 2)];
  const pick = async (f: Folder) => {
    if (!f.browse) return onPick(f.path);
    const dir = await open({ directory: true, title: diff ? "Folder with the repository" : "Folder for the new terminal" });
    if (typeof dir === "string") onPick(dir);
  };

  return (
    <Command
      shouldFilter={false}
      vimBindings={false}
      className="h-auto rounded-xl! border shadow-xs"
      label={diff ? "Folder with the repository" : "Folder for the new terminal"}
    >
      <CommandInput
        data-pane-autofocus
        autoFocus
        value={search}
        onValueChange={setSearch}
        placeholder="Search folders…"
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          e.stopPropagation();
          if (search) setSearch("");
          else onBack();
        }}
      />
      <CommandList className="max-h-[50vh]">
        <CommandGroup heading={diff ? "Show the changes of" : "Start the shell in"}>
          {list.map((f) => (
            <CommandItem key={f.id} value={f.id} title={f.path ? compactPath(f.path) : undefined} onSelect={() => void pick(f)}>
              {f.icon ?? <FolderOpen />}
              <span className="truncate">{f.label}</span>
              {f.detail && (
                <Badge variant="outline" className="max-w-40 min-w-12 shrink-[4] justify-start font-normal text-muted-foreground">
                  <span className="truncate">{f.detail}</span>
                </Badge>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup>
          <CommandItem value="back" onSelect={onBack}>
            <ArrowLeft /> Back
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
