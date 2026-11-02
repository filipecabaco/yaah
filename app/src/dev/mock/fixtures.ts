// Typed readers for the recorded fixtures in src/dev/fixtures. They are loaded
// as `unknown` (no giant inferred JSON types) and checked here once.
import type { Entry, UiComponent } from "@/lib/api";
import { asArray, asNumber, asObj, asString, isObj, type Obj } from "@/lib/narrow";
import catalogue from "@/ui-primitives.json";

const files = import.meta.glob<unknown>("../fixtures/*.json", { eager: true, import: "default" });

function fixture(name: string): unknown {
  const key = `../fixtures/${name}.json`;
  if (!(key in files)) throw new Error(`browser mock: no fixture ${name}.json`);
  return files[key];
}

/** One recorded event: a chat's status, or a transcript entry at an index. */
export type Step = { event: "session-info"; running: boolean; stopReason: string | null } | { event: "session-entry"; index: number; entry: Entry };
export type Recording = readonly Step[];

/** A `YAAH_RECORD` file: `{ event, payload }` as Rust emitted them. Never mutated. */
function readRecording(name: string): Recording {
  return asArray(fixture(name)).map((raw, i): Step => {
    const { event, payload } = asObj(raw);
    const p = asObj(payload);
    if (event === "session-info") return { event, running: p.running === true, stopReason: asString(p.stopReason) ?? null };
    const index = asNumber(p.index);
    if (event !== "session-entry" || index === undefined || !isObj(p.entry) || typeof p.entry.type !== "string")
      throw new Error(`browser mock: ${name}.json event ${i} isn't a session event`);
    return { event, index, entry: p.entry as Entry };
  });
}

/** The recorded chats, by the test in session.rs that recorded them. */
export const recordings = {
  /** `live_chat`: one Write tool call behind a permission prompt. */
  chat: readRecording("live-chat"),
  /** `live_ui`: the agent builds a library component and renders it. */
  ui: readRecording("live-ui"),
  /** `live_showcase`: a todo page built, then reviewed with UI (permissions, a review panel). */
  showcase: readRecording("live-showcase"),
  /** `live_scenarios`: table, charts, map, crons, a sub-agent panel; saves components. */
  scenarios: readRecording("live-scenarios"),
  /** `live_ask`: Claude asks with a form (ui_ask), then recommends. */
  ask: readRecording("live-ask"),
  /** `live_pack`: the yaah pack, live sources, and a form filled in together (ui_set_values). */
  pack: readRecording("live-pack"),
};

/** Samples recorded from the real source readers (src-tauri/src/sources.rs), by source kind. */
export const sourceSamples: Obj = asObj(fixture("sources"));

// ── components ──────────────────────────────────────────────────────────────

const primitives = asObj(catalogue.primitives);

/** The libraries a tree is built on, from the primitives it uses (as ui_library.rs derives them). */
function usesOf(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const n of node) usesOf(n, out);
  else if (isObj(node)) {
    const type = asString(node.type);
    if (type) for (const u of asArray(asObj(primitives[type]).uses)) if (typeof u === "string") out.add(u);
    usesOf(node.children, out);
    usesOf(node.else, out);
  }
  return out;
}

/** A component as `list_components` returns it, from a saved or bundled definition. */
export function component(raw: unknown, source: string, updatedAt: number): UiComponent {
  const c = asObj(raw);
  return {
    name: asString(c.name) ?? "",
    version: asNumber(c.version) ?? 1,
    description: asString(c.description) ?? "",
    props: asObj(c.props),
    tree: c.tree,
    examples: asArray(c.examples).map((e) => ({ title: asString(asObj(e).title) ?? "", props: asObj(asObj(e).props) })),
    changeNote: asString(c.changeNote) ?? null,
    updatedAt: asNumber(c.updatedAt) ?? updatedAt,
    source,
    uses: [...usesOf(c.tree)].sort(),
  };
}

/** The components yaah ships, straight from src-tauri/components (as Rust embeds them). */
export const bundledComponents = Object.values(
  import.meta.glob<unknown>("../../../src-tauri/components/*.json", { eager: true, import: "default" }),
).map((c) => component(c, "yaah", 0));
