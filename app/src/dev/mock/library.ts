// The component library (ui_library.rs): what yaah ships, what Claude saved in
// the live_scenarios run, and the one it built in the live_ui run.
import type { UiComponent } from "@/lib/api";
import { asObj, type Obj } from "@/lib/narrow";
import type { Replies } from "./context";
import { bundledComponents, component, recordings } from "./fixtures";

/** Rebuilt from the recorded `ui_save_component` calls. */
const scenarioComponents = recordings.scenarios.flatMap((s) =>
  s.event === "session-entry" && s.entry.type === "tool" && s.entry.title.endsWith("ui_save_component")
    ? [component(s.entry.rawInput, "local", 1793556372)]
    : [],
);

/** The first UI the live_ui agent rendered: its new component, expanded into a `$component` node. */
const builtEntry = recordings.ui.flatMap((s) => (s.event === "session-entry" && s.entry.type === "ui" ? [s.entry] : []))[0];
if (!builtEntry) throw new Error("browser mock: live-ui.json renders no UI");
const builtNode = asObj(builtEntry.tree);
const built: UiComponent = {
  name: builtEntry.component ?? "service-status-overview",
  version: builtEntry.version ?? 1,
  description: "Grid of service cards, each with a coloured status line and an optional metric. Use for health overviews of several services.",
  props: {
    type: "object",
    properties: { title: { type: "string" }, columns: { type: "number" }, services: { type: "array" } },
    required: ["services"],
  },
  tree: builtNode.tree,
  examples: [{ title: "Three services", props: builtEntry.props }],
  changeNote: null,
  updatedAt: 1793550000,
  source: "local",
  uses: [],
};

const previewable = [...bundledComponents, ...scenarioComponents];

export function libraryReplies(): Replies {
  return {
    list_components: (): UiComponent[] => [...bundledComponents, ...scenarioComponents, built],
    preview_component: ({ name, props }: { name: string; props: Obj }) => {
      const c = previewable.find((x) => x.name === name);
      // Anything else previews as the live_ui component, with its recorded expansion.
      if (!c) return { tree: builtNode, props };
      return { tree: { type: "$component", name, version: c.version, props, tree: c.tree }, props };
    },
  };
}
