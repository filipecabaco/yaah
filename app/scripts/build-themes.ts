// Builds src/lib/themes.json: every VS Code theme @shikijs/themes bundles,
// mapped to yaah's palette by src/lib/theme-map.ts, so the picker lists and
// previews them without loading 65 theme files. Also audits them: the build
// fails if any theme comes out unreadable. Run after upgrading @shikijs/themes:
//   pnpm themes
// (Node, not Elixir: it runs the app's own TypeScript mapping over an npm package.)
import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { chartPaletteFor, legibility, toPalette, type VsCodeTheme } from "../src/lib/theme-map.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../node_modules/@shikijs/themes/dist");
const names = readdirSync(dir)
  .filter((f) => f.endsWith(".mjs") && f !== "index.mjs")
  .map((f) => f.replace(/\.mjs$/, ""))
  .sort();

const MIN = {
  text: 4.5,
  muted: 4.5,
  mutedOnMuted: 4.5,
  mutedOnBubble: 4.5,
  accent: 3,
  onPrimary: 4.5,
  sidebarText: 4.5,
  sidebarMuted: 4.5,
  ring: 3,
  destructive: 4.5,
  destructiveOnTint: 4.5,
  input: 3,
};
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
console.log(
  "All pass: text and secondary text 4.5:1 (page, muted, bubble, sidebar), accent 3:1, button text 4.5:1, focus ring 3:1, destructive 4.5:1 on its tints, light input borders 3:1.",
);

// Chart colours: which source each theme's series come from (chart-palette.ts), and why the others were passed over.
const charts = themes.map((t) => ({ id: t.id, chart: chartPaletteFor(t.palette) }));
const bySource = new Map<string, number>();
for (const { chart } of charts) bySource.set(chart.source, (bySource.get(chart.source) ?? 0) + 1);
console.log(`Chart series: ${[...bySource].map(([s, n]) => `${n} from ${s}`).join(", ")}.`);
for (const { id, chart } of charts) {
  if (!chart.skipped.length && chart.divSource === chart.source) continue;
  const why = chart.skipped.map((s) => `${s.source}: ${s.problems.join("; ")}`).join(" | ");
  console.log(
    `  ${id} → ${chart.source}${why ? ` (${why})` : ""}${chart.divSource !== chart.source ? `; diverging poles from ${chart.divSource}` : ""}`,
  );
}
const unchecked = charts.filter(({ chart }) => !chart.check.ok);
if (unchecked.length) {
  console.error(
    "Chart colours that fail even after the fallback:\n" + unchecked.map(({ id, chart }) => `${id}: ${chart.check.problems.join("; ")}`).join("\n"),
  );
  process.exit(1);
}
