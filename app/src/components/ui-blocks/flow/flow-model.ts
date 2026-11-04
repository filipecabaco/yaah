// The `flow` primitive's props (sankey and network), read from untrusted JSON into fixed shapes,
// and the checks a layout needs before it runs: every link's ends are nodes, no self-links, and a
// sankey flows one way (d3-sankey throws on a cycle; we say which nodes form it). Pure, and in
// step with src-tauri/src/ui_library/flow.rs, which refuses the same things before render.
import { asArray, asNumber, isObj, optText, show, type Obj } from "@/lib/narrow";
import { isTone, type Tone } from "@/components/ui-blocks/viz";

export type FlowKind = "sankey" | "network";
export type FlowNode = { id: string; label: string; group?: string; size?: number; tone: Tone };
export type FlowLink = { source: string; target: string; value: number; label?: string };
export type Flow = {
  kind: FlowKind;
  nodes: FlowNode[];
  links: FlowLink[];
  unit?: string;
  height: number;
  title?: string;
  labels: "auto" | "all" | "none";
};

export const FLOW_CAPS: Record<FlowKind, { nodes: number; links: number }> = {
  sankey: { nodes: 200, links: 1000 },
  network: { nodes: 500, links: 2000 },
};
/** Network groups take categorical colours; past this many, colour can't tell them apart (the all-pairs CVD limit). */
export const MAX_GROUPS = 3;

export const readFlowKind = (v: unknown): FlowKind => (v === "network" ? "network" : "sankey");

/** The props, capped, plus the problems that stop a layout (shown as an error the agent can read). */
export function readFlow(p: Obj): { flow: Flow; errors: string[] } {
  const kind = readFlowKind(p.kind);
  const caps = FLOW_CAPS[kind];
  const errors: string[] = [];
  const rawNodes = asArray(p.nodes);
  const rawLinks = asArray(p.links);
  if (rawNodes.length > caps.nodes)
    errors.push(`A ${kind} takes at most ${caps.nodes} nodes; this one has ${rawNodes.length}. Group the small ones.`);
  if (rawLinks.length > caps.links) errors.push(`A ${kind} takes at most ${caps.links} links; this one has ${rawLinks.length}.`);
  const nodes: FlowNode[] = [];
  const seen = new Set<string>();
  for (const n of rawNodes.slice(0, caps.nodes)) {
    const id = isObj(n) ? optText(n.id) : typeof n === "string" ? n : undefined;
    if (!id) continue;
    if (seen.has(id)) {
      errors.push(`Node "${id}" is listed twice.`);
      continue;
    }
    seen.add(id);
    const o = isObj(n) ? n : {};
    const size = asNumber(o.size);
    nodes.push({
      id,
      label: optText(o.label)?.slice(0, 60) ?? id,
      group: optText(o.group)?.slice(0, 40),
      size: size != null && size >= 0 ? size : undefined,
      tone: isTone(o.tone) ? o.tone : "default",
    });
  }
  const links: FlowLink[] = [];
  rawLinks.slice(0, caps.links).forEach((l, i) => {
    if (!isObj(l)) return;
    const source = show(l.source);
    const target = show(l.target);
    const value = asNumber(l.value) ?? (kind === "network" ? 1 : NaN);
    if (!seen.has(source) || !seen.has(target)) {
      errors.push(`links[${i}] goes from "${source}" to "${target}", but ${!seen.has(source) ? `"${source}"` : `"${target}"`} isn't a node.`);
      return;
    }
    if (source === target) {
      errors.push(`links[${i}] goes from "${source}" to itself.`);
      return;
    }
    if (kind === "sankey" && !(value > 0)) {
      errors.push(`links[${i}] (${source} → ${target}) needs a value above 0; a sankey's widths are its values.`);
      return;
    }
    links.push({ source, target, value: Math.max(0, value), label: optText(l.label)?.slice(0, 60) });
  });
  if (kind === "sankey") {
    const cycle = findCycle(
      nodes.map((n) => n.id),
      links,
    );
    if (cycle) errors.push(`The links form a cycle (${cycle.join(" → ")}); a sankey flows one way. Split the node that repeats into two stages.`);
  }
  const height = asNumber(p.height);
  const labels = p.labels === "all" || p.labels === "none" ? p.labels : "auto";
  return {
    flow: {
      kind,
      nodes,
      links,
      unit: optText(p.unit)?.slice(0, 12),
      height: height ? Math.max(160, Math.min(900, height)) : kind === "sankey" ? 320 : 360,
      title: optText(p.title)?.slice(0, 120),
      labels,
    },
    errors,
  };
}

/** A cycle in the directed links, as the node ids round it (first repeated at the end), or null. */
export function findCycle(ids: string[], links: { source: string; target: string }[]): string[] | null {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const l of links) out.get(l.source)?.push(l.target);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  // Iterative depth-first search, so a long chain can't overflow the call stack.
  for (const start of ids) {
    if (state.get(start)) continue;
    const todo: [string, number][] = [[start, 0]];
    state.set(start, 1);
    stack.push(start);
    while (todo.length) {
      const top = todo[todo.length - 1];
      const next = out.get(top[0])?.[top[1]++];
      if (next == null) {
        state.set(top[0], 2);
        stack.pop();
        todo.pop();
      } else if (state.get(next) === 1) {
        return [...stack.slice(stack.indexOf(next)), next];
      } else if (!state.get(next)) {
        state.set(next, 1);
        stack.push(next);
        todo.push([next, 0]);
      }
    }
  }
  return null;
}

/** Group → colour slot (0-based) for the first MAX_GROUPS groups, in the order they first appear. */
export function groupSlots(nodes: FlowNode[]): Map<string, number> {
  const slots = new Map<string, number>();
  for (const n of nodes) if (n.group && !slots.has(n.group) && slots.size < MAX_GROUPS) slots.set(n.group, slots.size);
  return slots;
}
