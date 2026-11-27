// ⌘P in the editor pane: files of the folder by fuzzy path (files.rs `search`, as the composer's @-mentions).
import { useEffect, useState } from "react";
import { File } from "lucide-react";
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { editorApi, type FileMatch } from "@/lib/editor-api";

export function QuickOpen({ root, onClose, onPick }: { root: string; onClose: () => void; onPick: (path: string) => void }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; list: FileMatch[] } | null>(null);
  useEffect(() => {
    let current = true;
    const t = setTimeout(() => {
      editorApi.find(root, query).then(
        (list) => current && setFound({ query, list }),
        () => current && setFound({ query, list: [] }),
      );
    }, 60);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [root, query]);
  // Only the current query's matches: an Enter while they load must not pick a stale one.
  const list = found?.query === query ? found.list : null;
  // Enter pressed while they load: the first match, once it is in.
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (pending === null || !list || pending !== query) return;
    if (list[0]) onPick(list[0].label);
  }, [pending, list, query, onPick]);
  return (
    <CommandDialog open onOpenChange={(o) => !o && onClose()} title="Go to file" description="Search the folder's files by name">
      <Command shouldFilter={false}>
        <CommandInput
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Search files by name"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !list) setPending(query);
          }}
        />
        <CommandList>
          {list?.length === 0 && <CommandEmpty>No matching files.</CommandEmpty>}
          <CommandGroup>
            {list?.map((f) => {
              // One root, so the label is the path relative to it.
              const rel = f.label;
              const slash = rel.lastIndexOf("/");
              return (
                <CommandItem key={f.path} value={f.path} onSelect={() => onPick(rel)}>
                  <File />
                  <span className="truncate">{slash >= 0 ? rel.slice(slash + 1) : rel}</span>
                  {slash >= 0 && <span className="truncate text-xs text-muted-foreground">{rel.slice(0, slash)}</span>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
