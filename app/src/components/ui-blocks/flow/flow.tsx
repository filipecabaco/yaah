// `flow` primitive: quantities flowing between stages (`sankey`, d3-sankey) and relationships
// between things (`network`, d3-force), drawn by React as SVG on the shared figure core (viz/).
// d3 only computes the layout: the sankey per size, the network once per data change (seeded and
// run to a fixed number of ticks, in a worker when large). Labels are visible for small graphs;
// arrows move focus node to node, Enter steps along a node's links and Escape returns; hover and
// focus show the same tooltip; the table view lists every link (sankey) or every node's
// neighbours (network). docs/research/d3-everywhere.md.
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ErrorText } from "@/components/error-text";
import { formatter } from "@/components/ui-blocks/chart-model";
import { useChartFont } from "@/components/ui-blocks/chart-font";
import {
  Legend,
  LegendItem,
  SquareSwatch,
  TONE_FILL,
  TONE_WORD,
  ViewToggle,
  VizTable,
  VizTooltip,
  linearStep,
  seriesColor,
  spatialStep,
  useRoving,
  useSize,
  type Column,
} from "@/components/ui-blocks/viz";
import { groupSlots, readFlow, type Flow, type FlowNode } from "@/components/ui-blocks/flow/flow-model";
import { layoutSankey, NODE_WIDTH, placeSankeyLabels, type SankeyLabel, type SankeyLayout } from "@/components/ui-blocks/flow/sankey-layout";
import { fitLayout, layoutNetwork, WORKER_MIN, type NetIn, type NetOut } from "@/components/ui-blocks/flow/network-layout";
import { placePointLabels } from "@/components/ui-blocks/map/labels";
import { growAttr, growClass, useUiView } from "@/components/ui-view";
import type { Obj } from "@/lib/narrow";
import { cn } from "@/lib/utils";

const VIEWS = ["graph", "table"] as const;
const HALO = { stroke: "var(--chart-surface)", strokeWidth: 3, strokeLinejoin: "round", paintOrder: "stroke" } as const;
/** Labels on every node up to this many; past it, the biggest few. */
const ALL_LABELS = 40;
const TOP_LABELS = 12;

export default function UiFlow({ props }: { props: Obj }) {
  const key = JSON.stringify(props);
  const { flow, errors } = useMemo(() => readFlow(JSON.parse(key) as Obj), [key]);
  if (errors.length) return <ErrorText error={errors.slice(0, 4).join(" ")} />;
  return flow.kind === "sankey" ? <Sankey flow={flow} /> : <Network flow={flow} />;
}

/** What hovering or focusing shows, and the words a mark is named by. */
type Tip = { anchor: { x: number; y: number }; title: string; lines: string[]; /** The first line is a value (tabular figures). */ value?: boolean };

/** The figure's measured box: the inline height, or, expanded, the dialog's height left (at least the inline one). */
function useFigureSize(flow: Flow) {
  const { expanded } = useUiView();
  const { ref, width, height: measured } = useSize({ width: 640, height: flow.height });
  return { ref, width, height: expanded ? Math.max(240, measured) : flow.height, expanded };
}

/** The figure's frame: the graph/table switch, the box, the tooltip, the legend. */
function Frame(props: {
  flow: Flow;
  kind: "sankey" | "network";
  size: ReturnType<typeof useFigureSize>;
  figure: ReactNode;
  tip: Tip | null;
  tipId: string;
  table: ReactNode;
  legend?: ReactNode;
  onLeave: () => void;
}) {
  const { flow } = props;
  const { ref, width, height, expanded } = props.size;
  const [view, setView] = useState<(typeof VIEWS)[number]>("graph");
  return (
    <div className="ui-flow flex min-w-0 flex-col gap-2" data-flow-kind={props.kind}>
      <ViewToggle value={view} onChange={setView} views={VIEWS} />
      {view === "graph" ? (
        <>
          <div
            ref={ref}
            {...growAttr(expanded)}
            role="region"
            aria-label={`${props.kind === "sankey" ? "Sankey" : "Network"}, ${flow.title ?? `${flow.nodes.length} nodes, ${flow.links.length} links`}`}
            className={cn("relative w-full", expanded ? growClass(true, "") : "shrink-0", "overflow-hidden")}
            style={expanded ? { minHeight: flow.height } : { height: flow.height }}
            onPointerLeave={props.onLeave}
          >
            {props.figure}
            {props.tip && (
              <VizTooltip id={props.tipId} anchor={props.tip.anchor} box={{ w: width, h: height }}>
                <div className="font-medium">{props.tip.title}</div>
                {props.tip.lines.map((l, i) => (
                  <div
                    key={i}
                    className={i === 0 && props.tip!.value !== false ? "font-mono font-medium text-foreground tabular-nums" : "text-muted-foreground"}
                  >
                    {l}
                  </div>
                ))}
              </VizTooltip>
            )}
          </div>
          {props.legend}
        </>
      ) : (
        props.table
      )}
    </div>
  );
}

/** Focus along a node's links: Enter on a node goes to its first link, arrows move between them, Escape (or Enter) goes back. */
function useLinkFocus(count: number, back: () => void) {
  const refs = useRef<(SVGElement | null)[]>([]);
  const [path, setPath] = useState<number[]>([]);
  const enter = (links: number[]) => {
    if (!links.length) return;
    setPath(links);
    refs.current[links[0]]?.focus();
  };
  const onKey = (e: KeyboardEvent, link: number) => {
    const at = path.indexOf(link);
    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      setPath([]);
      back();
      return;
    }
    const next = linearStep(e.key, at, path.length);
    if (next == null || at < 0) return;
    e.preventDefault();
    refs.current[path[next]]?.focus();
  };
  return { refs, enter, onKey, count };
}

// ── sankey ───────────────────────────────────────────────────────────────────

function Sankey({ flow }: { flow: Flow }) {
  const font = useChartFont();
  const fmt = useMemo(() => formatter(flow.unit), [flow.unit]);
  const tipId = useId();
  const [active, setActive] = useState<{ node?: number; link?: number } | null>(null);
  const tone = new Map(flow.nodes.map((n) => [n.id, n.tone]));
  const label = new Map(flow.nodes.map((n) => [n.id, n.label]));
  /** A band's fill and edge: a tone when it runs to or from a toned node, else the neutral pair (index.css `--flow-*`). */
  const linkColor = (s: string, t: string) => {
    const k = tone.get(t) !== "default" ? tone.get(t)! : tone.get(s)!;
    return k === "default" ? { fill: "var(--muted-foreground)", edge: "var(--flow-edge)" } : { fill: TONE_FILL[k], edge: TONE_FILL[k] };
  };
  const size = useFigureSize(flow);
  const { width, height } = size;
  const layout: SankeyLayout = useMemo(() => layoutSankey(flow.nodes, flow.links, width, height), [flow, width, height]);
  const nodeLabels = useMemo(
    () =>
      flow.labels === "none"
        ? new Map<string, SankeyLabel>()
        : placeSankeyLabels(layout.nodes, (n) => `${n.label} ${fmt(n.value)}`, font, width, height, layout.columns),
    [layout, flow.labels, fmt, font, width, height],
  );
  // Nodes in reading order: column by column, top to bottom.
  const order = layout.nodes
    .map((_, i) => i)
    .sort((a, b) => layout.nodes[a].depth - layout.nodes[b].depth || layout.nodes[a].y0 - layout.nodes[b].y0);
  const centres = order.map((i) => ({ x: (layout.nodes[i].x0 + layout.nodes[i].x1) / 2, y: (layout.nodes[i].y0 + layout.nodes[i].y1) / 2 }));
  const roving = useRoving(order.length, (k, i) => spatialStep(k, i, centres));
  const linkFocus = useLinkFocus(layout.links.length, () => roving.focusItem(roving.focus));
  const nodeWords = (i: number) => {
    const n = layout.nodes[i];
    const lines = [
      n.inValue && n.outValue ? `${fmt(n.inValue)} in, ${fmt(n.outValue)} out` : fmt(n.value),
      n.inValue && !n.outValue ? "end" : !n.inValue ? "start" : "",
    ].filter(Boolean);
    const t = tone.get(n.id);
    if (t && t !== "default") lines.push(TONE_WORD[t]);
    return { title: n.label, lines };
  };
  const linkWords = (j: number) => {
    const l = layout.links[j];
    return {
      title: `${label.get(l.source)} → ${label.get(l.target)}`,
      lines: [fmt(l.value), ...(flow.links[l.i]?.label ? [flow.links[l.i].label!] : [])],
    };
  };
  const tip: Tip | null =
    active?.node != null
      ? {
          anchor: { x: layout.nodes[active.node].x1, y: (layout.nodes[active.node].y0 + layout.nodes[active.node].y1) / 2 },
          ...nodeWords(active.node),
        }
      : active?.link != null
        ? { anchor: layout.links[active.link].mid, ...linkWords(active.link) }
        : null;
  const linksOf = (id: string) => layout.links.flatMap((l, j) => (l.source === id || l.target === id ? [j] : []));
  const columns: Column[] = [
    { key: "source", label: "Source" },
    { key: "target", label: "Target" },
    { key: "value", label: "Value", numeric: true },
  ];
  const tones = [...new Set(flow.nodes.map((n) => n.tone))].filter((t) => t !== "default");

  return (
    <Frame
      flow={flow}
      kind="sankey"
      size={size}
      tip={tip}
      tipId={tipId}
      onLeave={() => setActive(null)}
      legend={
        tones.length > 0 && (
          <Legend>
            {tones.map((t) => (
              <LegendItem key={t} swatch={<SquareSwatch fill={TONE_FILL[t]} />} label={`To or from a ${TONE_WORD[t]} node`} />
            ))}
          </Legend>
        )
      }
      table={
        <VizTable
          caption={flow.title}
          columns={columns}
          rows={flow.links.map((l) => ({ source: label.get(l.source), target: label.get(l.target), value: fmt(l.value) }))}
        />
      }
      figure={(() => {
        const l = layout;
        return (
          <svg
            width={width}
            height={height}
            role="group"
            aria-label={flow.title ?? "Sankey diagram"}
            className="block tabular-nums"
            style={{ fontSize: font }}
          >
            <g data-part="links">
              {l.links.map((b, j) => {
                const on =
                  active?.link === j || (active?.node != null && (l.nodes[active.node].id === b.source || l.nodes[active.node].id === b.target));
                const w = linkWords(j);
                const c = linkColor(b.source, b.target);
                // A quiet fill that crossings show through, edged by a 1px hairline at 3:1 on the surface, so
                // each band's extent reads in every theme without the bands turning into slabs.
                return (
                  <path
                    key={j}
                    ref={(el) => {
                      linkFocus.refs.current[j] = el;
                    }}
                    d={b.area}
                    fill={c.fill}
                    style={{ fillOpacity: on ? "var(--flow-band-on)" : "var(--flow-band)" }}
                    stroke={c.edge}
                    strokeWidth={1}
                    data-part="band"
                    tabIndex={-1}
                    role="img"
                    aria-label={`${w.title}, ${w.lines.join(", ")}`}
                    aria-describedby={active?.link === j ? tipId : undefined}
                    className="outline-none"
                    data-link={`${b.source}>${b.target}`}
                    onPointerEnter={() => setActive({ link: j })}
                    onFocus={() => setActive({ link: j })}
                    onBlur={() => setActive(null)}
                    onKeyDown={(e) => linkFocus.onKey(e, j)}
                  />
                );
              })}
            </g>
            <g data-part="nodes">
              {order.map((i, k) => {
                const n = l.nodes[i];
                const words = nodeWords(i);
                const t = tone.get(n.id) ?? "default";
                const props = roving.props(k);
                const at = nodeLabels.get(n.id);
                return (
                  <g
                    key={n.id}
                    {...props}
                    role="img"
                    aria-label={`${words.title}, ${words.lines.join(", ")}`}
                    aria-describedby={active?.node === i ? tipId : undefined}
                    className="outline-none"
                    data-node={n.id}
                    onPointerEnter={() => setActive({ node: i })}
                    onFocus={() => {
                      setActive({ node: i });
                      roving.setFocus(k);
                    }}
                    onBlur={() => setActive(null)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        linkFocus.enter(linksOf(n.id));
                      } else props.onKeyDown(e);
                    }}
                  >
                    <rect x={n.x0} y={n.y0} width={NODE_WIDTH} height={Math.max(1, n.y1 - n.y0)} rx={2} fill={TONE_FILL[t]} />
                    {active?.node === i && (
                      <rect
                        x={n.x0 - 2}
                        y={n.y0 - 2}
                        width={NODE_WIDTH + 4}
                        height={Math.max(1, n.y1 - n.y0) + 4}
                        rx={3}
                        fill="none"
                        stroke="var(--foreground)"
                        strokeWidth={2}
                      />
                    )}
                    {at && (
                      <text x={at.x} y={at.y} textAnchor={at.anchor} dominantBaseline="central" fill="var(--foreground)" {...HALO} data-part="label">
                        {n.label} <tspan className="fill-muted-foreground">{fmt(n.value)}</tspan>
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        );
      })()}
    />
  );
}

// ── network ──────────────────────────────────────────────────────────────────

/** The settled layout: computed once per graph, on the main thread when small, in a worker from WORKER_MIN nodes. */
function useNetworkLayout(input: NetIn): NetOut | null {
  const key = JSON.stringify(input);
  const big = input.nodes.length >= WORKER_MIN && typeof Worker !== "undefined";
  const sync = useMemo(() => (big ? null : layoutNetwork(JSON.parse(key) as NetIn)), [key, big]);
  const [async, setAsync] = useState<{ key: string; out: NetOut } | null>(null);
  useEffect(() => {
    if (!big) return;
    const worker = new Worker(new URL("./network-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ out: NetOut }>) => setAsync({ key, out: e.data.out });
    worker.postMessage({ id: 0, input: JSON.parse(key) as NetIn });
    return () => worker.terminate();
  }, [key, big]);
  return sync ?? (async?.key === key ? async.out : null);
}

function Network({ flow }: { flow: Flow }) {
  const font = useChartFont();
  const fmt = useMemo(() => formatter(flow.unit), [flow.unit]);
  const tipId = useId();
  const [active, setActive] = useState<number | null>(null);
  const input = useMemo<NetIn>(() => ({ nodes: flow.nodes.map((n) => ({ id: n.id, size: n.size })), links: flow.links }), [flow]);
  const layout = useNetworkLayout(input);
  const slots = useMemo(() => groupSlots(flow.nodes), [flow.nodes]);
  const index = useMemo(() => new Map(flow.nodes.map((n, i) => [n.id, i])), [flow.nodes]);
  const neighbours = useMemo(() => {
    const m = flow.nodes.map(() => [] as { other: number; link: number }[]);
    flow.links.forEach((l, j) => {
      const a = index.get(l.source)!;
      const b = index.get(l.target)!;
      m[a].push({ other: b, link: j });
      m[b].push({ other: a, link: j });
    });
    return m;
  }, [flow, index]);
  const anyValue = flow.links.some((l) => l.value !== 1);
  const maxValue = Math.max(1, ...flow.links.map((l) => l.value));
  const strokeOf = (v: number) => (anyValue ? 1 + 2.5 * Math.sqrt(v / maxValue) : 1.25);
  const colorOf = (n: FlowNode) =>
    !slots.size ? "var(--chart-1)" : n.group != null && slots.has(n.group) ? seriesColor(slots.get(n.group)!) : "var(--muted-foreground)";
  const size = useFigureSize(flow);
  const box = { width: size.width, height: size.height };
  const placed = useMemo(() => (layout ? fitLayout(layout, size.width, size.height, 18) : null), [layout, size.width, size.height]);
  const centres = placed ? placed.x.map((x, i) => ({ x, y: placed.y[i] })) : [];
  const roving = useRoving(flow.nodes.length, (k, i) => spatialStep(k, i, centres));
  const linkFocus = useLinkFocus(flow.links.length, () => roving.focusItem(roving.focus));
  const words = (i: number) => {
    const n = flow.nodes[i];
    const near = neighbours[i];
    const names = near.slice(0, 4).map((x) => flow.nodes[x.other].label);
    return {
      title: n.label,
      lines: [
        `${near.length} link${near.length === 1 ? "" : "s"}${n.size != null ? `, size ${formatter()(n.size)}` : ""}`,
        ...(n.group ? [`group ${n.group}`] : []),
        ...(names.length ? [`to ${names.join(", ")}${near.length > 4 ? "…" : ""}`] : []),
      ],
    };
  };
  const linkWords = (j: number) => {
    const l = flow.links[j];
    return {
      title: `${flow.nodes[index.get(l.source)!].label} → ${flow.nodes[index.get(l.target)!].label}`,
      lines: [anyValue ? fmt(l.value) : "linked", ...(l.label ? [l.label] : [])],
    };
  };
  const [activeLink, setActiveLink] = useState<number | null>(null);
  const tip: Tip | null =
    placed && active != null
      ? { anchor: { x: placed.x[active] + (layout?.r[active] ?? 6), y: placed.y[active] }, ...words(active), value: false }
      : placed && activeLink != null
        ? (() => {
            const l = flow.links[activeLink];
            const a = index.get(l.source)!;
            const b = index.get(l.target)!;
            return { anchor: { x: (placed.x[a] + placed.x[b]) / 2, y: (placed.y[a] + placed.y[b]) / 2 }, ...linkWords(activeLink) };
          })()
        : null;
  // Labels: every node in a small graph, else the most connected few; never overlapping.
  const labelled = useMemo(() => {
    if (flow.labels === "none" || !placed || !layout) return [];
    const rank = flow.nodes.map((n, i) => [n.size ?? neighbours[i].length, i] as const).sort(([a, i], [b, j]) => b - a || i - j);
    const pick = flow.labels === "all" || flow.nodes.length <= ALL_LABELS ? rank : rank.slice(0, TOP_LABELS);
    return placePointLabels(
      pick.map(([, i]) => ({ key: flow.nodes[i].id, text: flow.nodes[i].label, x: placed.x[i], y: placed.y[i], r: layout.r[i] })),
      font,
      { width: size.width, height: size.height },
    );
  }, [flow, layout, placed, size.width, size.height, font, neighbours]);
  const groups = [...slots.keys()];
  const columns: Column[] = [
    { key: "node", label: "Node" },
    { key: "group", label: "Group" },
    { key: "links", label: "Links", numeric: true },
    { key: "to", label: "Connected to" },
  ];
  return (
    <Frame
      flow={flow}
      kind="network"
      size={size}
      tip={tip}
      tipId={tipId}
      onLeave={() => {
        setActive(null);
        setActiveLink(null);
      }}
      legend={
        groups.length > 0 && (
          <Legend>
            {groups.map((g) => (
              <LegendItem key={g} swatch={<SquareSwatch fill={seriesColor(slots.get(g)!)} />} label={g} />
            ))}
            {flow.nodes.some((n) => n.group && !slots.has(n.group)) && (
              <LegendItem swatch={<SquareSwatch fill="var(--muted-foreground)" />} label="Other groups" />
            )}
          </Legend>
        )
      }
      table={
        <VizTable
          caption={flow.title ? `${flow.title}: each node and the nodes it links to.` : "Each node and the nodes it links to."}
          columns={columns}
          rows={flow.nodes.map((n, i) => ({
            node: n.label,
            group: n.group ?? "",
            links: neighbours[i].length,
            to: neighbours[i].map((x) => flow.nodes[x.other].label + (anyValue ? ` (${fmt(flow.links[x.link].value)})` : "")).join(", "),
          }))}
        />
      }
      figure={(() => {
        const { width, height } = box;
        if (!layout || !placed) {
          return (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground" role="status">
              Laying out {flow.nodes.length} nodes…
            </div>
          );
        }
        const p = placed;
        return (
          <svg
            width={width}
            height={height}
            role="group"
            aria-label={flow.title ?? "Network graph"}
            className="block tabular-nums"
            style={{ fontSize: font }}
          >
            <g data-part="links">
              {flow.links.map((l, j) => {
                const a = index.get(l.source)!;
                const b = index.get(l.target)!;
                const on = activeLink === j || active === a || active === b;
                const w = linkWords(j);
                return (
                  <line
                    key={j}
                    ref={(el) => {
                      linkFocus.refs.current[j] = el;
                    }}
                    x1={p.x[a]}
                    y1={p.y[a]}
                    x2={p.x[b]}
                    y2={p.y[b]}
                    stroke={on ? "var(--foreground)" : "var(--muted-foreground)"}
                    strokeOpacity={on ? 0.8 : 0.45}
                    strokeWidth={strokeOf(l.value)}
                    tabIndex={-1}
                    role="img"
                    aria-label={`${w.title}, ${w.lines.join(", ")}`}
                    className="outline-none"
                    data-link={`${l.source}>${l.target}`}
                    onPointerEnter={() => setActiveLink(j)}
                    onFocus={() => {
                      setActive(null);
                      setActiveLink(j);
                    }}
                    onBlur={() => setActiveLink(null)}
                    onKeyDown={(e) => linkFocus.onKey(e, j)}
                  />
                );
              })}
            </g>
            <g data-part="nodes">
              {flow.nodes.map((n, i) => {
                const props = roving.props(i);
                const w = words(i);
                const r = layout.r[i];
                return (
                  <g
                    key={n.id}
                    {...props}
                    role="img"
                    aria-label={`${w.title}, ${w.lines.join(", ")}`}
                    aria-describedby={active === i ? tipId : undefined}
                    className="outline-none"
                    data-node={n.id}
                    onPointerEnter={() => setActive(i)}
                    onFocus={() => {
                      setActiveLink(null);
                      setActive(i);
                      roving.setFocus(i);
                    }}
                    onBlur={() => setActive(null)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        linkFocus.enter(neighbours[i].map((x) => x.link));
                      } else props.onKeyDown(e);
                    }}
                  >
                    <circle cx={p.x[i]} cy={p.y[i]} r={r + 1.5} fill="var(--chart-surface)" />
                    <circle cx={p.x[i]} cy={p.y[i]} r={r} fill={colorOf(n)} data-mark="node" />
                    {active === i && <circle cx={p.x[i]} cy={p.y[i]} r={r + 3} fill="none" stroke="var(--foreground)" strokeWidth={2} />}
                    <circle cx={p.x[i]} cy={p.y[i]} r={Math.max(12, r)} fill="transparent" data-part="hit" />
                  </g>
                );
              })}
            </g>
            <g aria-hidden pointerEvents="none" data-part="labels">
              {labelled.map((l) => (
                <text
                  key={l.key}
                  x={l.x}
                  y={l.y}
                  textAnchor={l.anchor}
                  dominantBaseline="central"
                  fill="var(--foreground)"
                  {...HALO}
                  data-part="label"
                >
                  {l.text}
                </text>
              ))}
            </g>
          </svg>
        );
      })()}
    />
  );
}
