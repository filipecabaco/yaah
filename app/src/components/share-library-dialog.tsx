// "Share as library…": export some of the user's own components as a library
// folder (yaah-library.json + components/), ready to push to a git repo that
// others install from Settings → Components. Rust writes the folder, rewrites
// references between the exported components, and reports local components the
// picked ones use but weren't picked, so they can be added.
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CircleAlert, CircleCheck, Copy, FolderOpen, Loader2, PackagePlus } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ErrorText } from "@/components/error-text";
import { libraryApi, type LibraryManifest, type UiComponent } from "@/lib/api";
import { compactPath, plural } from "@/lib/format";

/** A shell word: quoted when it has anything a shell would split or expand. */
const shellWord = (s: string) => (/^[\w./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** What to run in the exported folder to publish it. */
function publishCommands(path: string, manifest: Pick<LibraryManifest, "name" | "version">): string {
  return [
    `cd ${shellWord(path)}`,
    "git init",
    "git add .",
    `git commit -m ${shellWord(`Publish ${manifest.name} ${manifest.version}`)}`,
    "git remote add origin <repo-url>",
    "git push -u origin HEAD",
  ].join(" && \\\n  ");
}

export function ShareLibraryDialog({ components, initial, onClose }: { components: UiComponent[]; initial: string[]; onClose: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial));
  const [manifest, setManifest] = useState<LibraryManifest>({ name: "", title: "", description: "", publisher: "", homepage: "", version: "1.0.0" });
  const [dir, setDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [exported, setExported] = useState<{ path: string; count: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const edit = (patch: Partial<LibraryManifest>) => setManifest((m) => ({ ...m, ...patch }));
  const toggle = (name: string, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const chooseDir = async () => {
    try {
      const d = await open({ directory: true, title: "Where to save the library" });
      if (typeof d === "string") setDir(d);
    } catch (e) {
      setError(e);
    }
  };

  const exportWith = async (names: string[]) => {
    if (!dir || busy) return;
    setBusy(true);
    setError(null);
    setMissing([]);
    try {
      // Optional fields go out absent rather than empty.
      const m: LibraryManifest = {
        name: manifest.name.trim(),
        title: manifest.title.trim(),
        description: manifest.description.trim(),
        version: manifest.version.trim(),
        ...(manifest.publisher?.trim() ? { publisher: manifest.publisher.trim() } : {}),
        ...(manifest.homepage?.trim() ? { homepage: manifest.homepage.trim() } : {}),
      };
      const r = await libraryApi.exportLibrary(dir, m, names);
      if (r.missing.length) setMissing(r.missing);
      else setExported({ path: r.path, count: names.length });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const addMissingAndExport = () => {
    const names = [...new Set([...picked, ...missing])];
    setPicked(new Set(names));
    void exportWith(names);
  };

  const ready = picked.size > 0 && manifest.name.trim() && manifest.title.trim() && manifest.version.trim() && dir;
  const allPicked = components.length > 0 && components.every((c) => picked.has(c.name));
  const commands = exported ? publishCommands(exported.path, { name: manifest.name.trim(), version: manifest.version.trim() }) : "";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[min(44rem,92vh)] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b p-4">
          <DialogTitle>Share as library</DialogTitle>
          <DialogDescription>
            Export some of your components as a folder others install from a git repo. Components are data, so a library can only render yaah's
            building blocks.
          </DialogDescription>
        </DialogHeader>

        {exported ? (
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4" role="status">
            <p className="flex items-start gap-2 text-sm">
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>
                Exported {plural(exported.count, "component")} to <span className="font-mono text-xs break-all">{exported.path}</span>.
              </span>
            </p>
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                To publish it, create an empty repo (GitHub, GitLab…), put its URL in place of{" "}
                <span className="font-mono text-xs">&lt;repo-url&gt;</span> and run:
              </p>
              <pre aria-label="Commands to publish" className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                {commands}
              </pre>
              <Button
                size="xs"
                variant="outline"
                className="self-start"
                onClick={() => {
                  navigator.clipboard.writeText(commands).then(
                    () => setCopied(true),
                    (e: unknown) => setError(e),
                  );
                }}
              >
                <Copy /> {copied ? "Copied" : "Copy commands"}
              </Button>
              <ErrorText error={error} />
            </div>
            <p className="text-sm text-muted-foreground">Others install it from Settings → Components with the repo's URL.</p>
          </div>
        ) : (
          <form
            id="share-library"
            className="flex min-h-0 flex-col gap-5 overflow-y-auto p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready) void exportWith([...picked]);
            }}
          >
            <div role="group" aria-labelledby="share-components" className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span id="share-components" className="text-sm font-medium">
                  Components
                </span>
                <span className="text-xs text-muted-foreground">{picked.size ? `${picked.size} picked` : "pick at least one"}</span>
                {components.length > 1 && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => setPicked(allPicked ? new Set() : new Set(components.map((c) => c.name)))}
                  >
                    {allPicked ? "Select none" : "Select all"}
                  </Button>
                )}
              </div>
              {components.length === 0 ? (
                <p className="text-sm text-muted-foreground">You have no components of your own yet. Copy one in, or ask an agent to build one.</p>
              ) : (
                <ul className="flex max-h-52 flex-col divide-y overflow-y-auto rounded-md border">
                  {components.map((c) => {
                    const id = `share-${c.name}`;
                    return (
                      <li key={c.name} className="flex items-start gap-2.5 px-3 py-2">
                        <Checkbox id={id} className="mt-0.5" checked={picked.has(c.name)} onCheckedChange={(v) => toggle(c.name, v === true)} />
                        <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col">
                          <span className="font-mono text-xs">{c.name}</span>
                          {c.description && <span className="line-clamp-1 text-xs text-muted-foreground">{c.description}</span>}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                id="lib-name"
                label="Name"
                hint="Its namespace: yours become name/component."
                mono
                value={manifest.name}
                placeholder="acme"
                onChange={(name) => edit({ name })}
              />
              <TextField
                id="lib-version"
                label="Version"
                mono
                value={manifest.version}
                placeholder="1.0.0"
                onChange={(version) => edit({ version })}
              />
              <TextField id="lib-title" label="Title" value={manifest.title} placeholder="Acme components" onChange={(title) => edit({ title })} />
              <TextField
                id="lib-publisher"
                label="Publisher (optional)"
                value={manifest.publisher ?? ""}
                placeholder="you or your team"
                onChange={(publisher) => edit({ publisher })}
              />
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="lib-description">Description</Label>
                <Textarea
                  id="lib-description"
                  rows={2}
                  value={manifest.description}
                  placeholder="What's in it and when to use it"
                  onChange={(e) => edit({ description: e.target.value })}
                />
              </div>
              <div className="sm:col-span-2">
                <TextField
                  id="lib-homepage"
                  label="Homepage (optional)"
                  value={manifest.homepage ?? ""}
                  placeholder="https://…"
                  onChange={(homepage) => edit({ homepage })}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Save to</span>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => void chooseDir()}>
                  <FolderOpen /> {dir ? "Change folder…" : "Choose folder…"}
                </Button>
                {dir && <span className="font-mono text-xs break-all">{compactPath(dir)}</span>}
              </div>
              <p className="text-xs text-muted-foreground">
                yaah writes a new <span className="font-mono">{manifest.name.trim() || "name"}/</span> folder inside it.
              </p>
            </div>
          </form>
        )}
        {/* Outside the scrolling form, so what went wrong is in view next to Export. */}
        {!exported && (missing.length > 0 || error != null) && (
          <div className="flex flex-col gap-2 border-t px-4 py-3">
            {missing.length > 0 && (
              <Alert>
                <CircleAlert />
                <AlertTitle>They use components you didn't pick</AlertTitle>
                <AlertDescription className="flex flex-col items-start gap-2">
                  <span>
                    {missing.map((n, i) => (
                      <span key={n}>
                        {i > 0 && ", "}
                        <span className="font-mono text-xs">{n}</span>
                      </span>
                    ))}
                    . Others won't have them, so the library needs them too. Nothing was written.
                  </span>
                  <Button type="button" size="xs" disabled={busy} onClick={addMissingAndExport}>
                    <PackagePlus /> Add {missing.length === 1 ? "it" : "them"} and export
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            <ErrorText error={error} className="text-sm whitespace-pre-wrap" />
          </div>
        )}

        <DialogFooter className="m-0 rounded-b-xl">
          {exported ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" form="share-library" disabled={!ready || busy}>
                {busy ? <Loader2 className="animate-spin" /> : <PackagePlus />} Export
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TextField({
  id,
  label,
  hint,
  mono,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  mono?: boolean;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className={mono ? "font-mono text-xs" : undefined}
        value={value}
        placeholder={placeholder}
        spellCheck={!mono}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
