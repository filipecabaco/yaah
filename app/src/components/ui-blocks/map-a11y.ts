// Map markers for the keyboard and assistive tech (SR-4): Leaflet draws a marker as a bare SVG
// path, with no role, name or tab stop. Kept apart from map.tsx, which is loaded on demand.

/** A marker's status in words, as its colour alone can't say it (WCAG 1.4.1). */
const TONE_WORD: Record<string, string> = { success: "good", warning: "warning", danger: "problem" };

/** A marker's accessible name: its label (or its place in the list) and its status. */
export function markerName(m: { label?: string; tone: string }, i: number, n: number): string {
  const name = m.label ?? `Marker ${i + 1} of ${n}`;
  const tone = TONE_WORD[m.tone];
  return tone ? `${name} (${tone})` : name;
}

/** Makes `el` a named button in the tab order: focus shows its label, Enter or Space opens its details. */
export function makeMarkerAccessible(el: Element | undefined, name: string, on: { open: () => void; focus: () => void; blur: () => void }) {
  if (!el) return;
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", name);
  el.addEventListener("focus", on.focus);
  el.addEventListener("blur", on.blur);
  el.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key !== "Enter" && key !== " ") return;
    e.preventDefault();
    on.open();
  });
}
