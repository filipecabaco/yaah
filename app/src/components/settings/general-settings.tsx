// Settings → General: appearance, the folders the repo picker scans, and where
// yaah keeps its data.
import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, FolderPlus, Monitor, Moon, Sun, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ErrorText } from "@/components/error-text";
import { Page, Section } from "@/components/settings/parts";
import { ThemePicker } from "@/components/settings/theme-picker";
import { api, type Appearance, type GeneralSettings } from "@/lib/api";
import { compactPath } from "@/lib/format";
import { BUNDLED, setAppearance, setThemes } from "@/lib/theme";

const APPEARANCE: { id: Appearance; label: string; icon: ReactNode }[] = [
  { id: "system", label: "System", icon: <Monitor className="size-4" /> },
  { id: "light", label: "Light", icon: <Sun className="size-4" /> },
  { id: "dark", label: "Dark", icon: <Moon className="size-4" /> },
];

export function GeneralSettings() {
  const [s, setS] = useState<GeneralSettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = () => {
    api.generalSettings().then(setS, setError);
  };
  useEffect(load, []);

  const pick = (appearance: Appearance) => {
    setAppearance(appearance);
    setS((x) => (x ? { ...x, appearance } : x));
    api.setAppearance(appearance).catch(setError);
  };
  const pickTheme = (theme: GeneralSettings["theme"]) => {
    setThemes(theme);
    setS((x) => (x ? { ...x, theme } : x));
    api.setTheme(theme.light, theme.dark).catch(setError);
  };
  const setRoots = (roots: string[]) => {
    setError(null);
    api.setWorkspaceRoots(roots).then(load, setError);
  };
  const addRoot = async () => {
    try {
      const dir = await open({ directory: true, title: "A folder where you keep repos" });
      if (typeof dir === "string" && s && !s.workspaceRoots.includes(dir)) setRoots([...s.workspaceRoots, dir]);
    } catch (e) {
      setError(e);
    }
  };

  if (!s) return error ? <ErrorText error={error} className="p-6 text-sm" /> : <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  return (
    <Page>
      <Section title="Appearance">
        <RadioGroup
          aria-label="Appearance"
          className="grid w-full max-w-md grid-cols-3 gap-2"
          value={s.appearance}
          onValueChange={(v) => pick(v as Appearance)}
        >
          {APPEARANCE.map((a) => (
            <Label
              key={a.id}
              htmlFor={`appearance-${a.id}`}
              className="flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border p-3 font-normal transition-colors hover:bg-muted has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 has-[[data-state=checked]]:font-medium"
            >
              <RadioGroupItem id={`appearance-${a.id}`} value={a.id} className="sr-only" />
              {a.icon}
              {a.label}
            </Label>
          ))}
        </RadioGroup>
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">Colors</h4>
          <p className="text-sm text-muted-foreground">
            yaah's own, or any VS Code colour theme: {BUNDLED.length} come with yaah, and any theme's .json dropped into the Themes folder below shows
            up here. Colours are adjusted where needed so text stays readable; charts keep their colour-blind-safe palette.
          </p>
          {(s.appearance === "system" || s.appearance === "light") && (
            <ThemePicker slot="light" value={s.theme.light} custom={s.customThemes} onPick={(id) => pickTheme({ ...s.theme, light: id })} />
          )}
          {(s.appearance === "system" || s.appearance === "dark") && (
            <ThemePicker slot="dark" value={s.theme.dark} custom={s.customThemes} onPick={(id) => pickTheme({ ...s.theme, dark: id })} />
          )}
        </div>
      </Section>

      <Section title="Workspace folders" about="Where the repo picker looks for git repos when you add repos to a project.">
        <ul className="flex flex-col divide-y rounded-lg border">
          {s.workspaceRoots.length === 0 && <li className="p-3 text-sm text-muted-foreground">None yet.</li>}
          {s.workspaceRoots.map((r) => (
            <li key={r} className="flex items-center gap-2 p-2 pl-3">
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-xs" title={r}>
                {compactPath(r)}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-auto"
                aria-label={`Remove ${compactPath(r)}`}
                onClick={() => setRoots(s.workspaceRoots.filter((x) => x !== r))}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
        <Button variant="outline" size="sm" className="self-start" onClick={() => void addRoot()}>
          <FolderPlus /> Add folder…
        </Button>
      </Section>

      <Section title="Data" about="Everything yaah keeps is on this machine.">
        <ul className="flex flex-col divide-y rounded-lg border">
          {s.dataDirs.map((d) => (
            <li key={d.path} className="flex items-center gap-3 p-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">{d.label}</span>
                <span className="text-xs text-muted-foreground">{d.about}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground" title={d.path}>
                  {compactPath(d.path)}
                </span>
              </div>
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto shrink-0"
                aria-label={`Reveal ${d.label}`}
                onClick={() => {
                  api.revealDataDir(d.path).catch(setError);
                }}
              >
                Reveal
              </Button>
            </li>
          ))}
        </ul>
      </Section>

      <ErrorText error={error} className="text-sm" />
      <p className="text-xs text-muted-foreground">yaah {s.version} · yet another agent harness</p>
    </Page>
  );
}
