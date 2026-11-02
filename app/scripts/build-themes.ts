// Builds src/lib/themes.json: every VS Code theme @shikijs/themes bundles,
// mapped to yaah's palette by src/lib/theme-map.ts, so the picker lists and
// previews them without loading 65 theme files. Also audits them: the build
// fails if any theme comes out unreadable. Run after upgrading @shikijs/themes:
//   pnpm themes
// (Node, not Elixir: it runs the app's own TypeScript mapping over an npm package.)
import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { legibility, toPalette, type VsCodeTheme } from "../src/lib/theme-map.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../node_modules/@shikijs/themes/dist");
const names = readdirSync(dir)
  .filter((f) => f.endsWith(".mjs") && f !== "index.mjs")
  .map((f) => f.replace(/\.mjs$/, ""))
  .sort();

const MIN = { text: 4.5, muted: 3, accent: 3, onPrimary: 4.5, sidebarText: 4.5, sidebarMuted: 3 };
const themes = [];
const failures: string[] = [];
for (const name of names) {
  const { default: theme } = (await import(pathToFileURL(join(dir, `${name}.mjs`)).href)) as { default: VsCodeTheme };
  const palette = toPalette(theme);
  const l = legibility(palette);
  for (const [k, min] of Object.entries(MIN)) {
    const v = l[k as keyof typeof l];
    if (v < min) failures.push(`${name}: ${k} ${v.toFixed(2)} < ${min}`);
  }
  themes.push({ id: `shiki:${name}`, label: theme.displayName ?? name, dark: palette.dark, palette });
}
writeFileSync(join(here, "../src/lib/themes.json"), JSON.stringify(themes, null, 1) + "\n");
const dark = themes.filter((t) => t.dark).length;
console.log(`${themes.length} themes (${dark} dark, ${themes.length - dark} light) → src/lib/themes.json`);
if (failures.length) {
  console.error("Unreadable after mapping:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("All pass: text 4.5:1, secondary text 3:1, accent 3:1, button text 4.5:1, sidebar text 4.5:1 and 3:1.");
