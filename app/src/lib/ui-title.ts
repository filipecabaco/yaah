// What a rendered UI in the transcript is called (ui-entry.tsx): its Expand button's name
// ("Expand src/billing/refund.rs") and its expanded dialog's title, so six UIs in a chat don't
// all say "Expand" and a dialog doesn't open on a component slug like "file-view" (SR-3).

/** Props that name what a UI shows, best first. */
const NAMING_PROPS = ["title", "path", "file", "name", "label"] as const;

/** "file-view" → "File view". */
function humanize(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : slug;
}

/**
 * A UI's human name: the title the agent gave it, else what its props say it shows (a title, a
 * file path, a name), else its component in words ("File view"), else "UI".
 */
export function uiTitle(ui: { title: string | null; component: string | null; props?: Record<string, unknown> }): string {
  if (ui.title?.trim()) return ui.title.trim();
  for (const key of NAMING_PROPS) {
    const v = ui.props?.[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
  }
  return ui.component ? humanize(ui.component) : "UI";
}
