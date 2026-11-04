// Marker clusters for the street map (map.tsx), pure so they are tested without Leaflet: markers
// are projected to pixels at the current zoom and bucketed in a square grid; a cell with two or
// more becomes one cluster at their mean position, showing the count and the worst status among
// them. A grid is enough for the 2,000 markers a map takes (one pass per zoom), and costs no
// dependency (leaflet.markercluster is 9 KB gzip and patches Leaflet; supercluster needs kdbush).

export type ClusterTone = "default" | "success" | "warning" | "danger";
/** Grid cell in px: about two markers' rings and a label apart. */
export const CLUSTER_CELL = 56;
/** `cluster: "auto"` groups markers from this many up. */
export const CLUSTER_MIN = 40;
/** At this zoom and closer, markers are never grouped (they are streets apart by then). */
export const CLUSTER_MAX_ZOOM = 16;

const WORST: Record<ClusterTone, number> = { default: 0, success: 1, warning: 2, danger: 3 };

export type Group =
  | { kind: "one"; index: number }
  | { kind: "many"; members: number[]; x: number; y: number; tone: ClusterTone; tones: Partial<Record<ClusterTone, number>> };

/**
 * Groups of markers at their pixel positions `xy`: lone markers stay themselves, two or more in
 * one grid cell become a cluster (in marker order, so the result is stable).
 */
export function clusterGrid(xy: [number, number][], tones: ClusterTone[], cell = CLUSTER_CELL): Group[] {
  const cells = new Map<string, number[]>();
  xy.forEach(([x, y], i) => {
    const k = `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
    const c = cells.get(k);
    if (c) c.push(i);
    else cells.set(k, [i]);
  });
  const out: Group[] = [];
  for (const members of cells.values()) {
    if (members.length === 1) {
      out.push({ kind: "one", index: members[0] });
      continue;
    }
    const counts: Partial<Record<ClusterTone, number>> = {};
    let tone: ClusterTone = "default";
    let x = 0;
    let y = 0;
    for (const i of members) {
      const t = tones[i] ?? "default";
      counts[t] = (counts[t] ?? 0) + 1;
      if (WORST[t] > WORST[tone]) tone = t;
      x += xy[i][0];
      y += xy[i][1];
    }
    out.push({ kind: "many", members, x: x / members.length, y: y / members.length, tone, tones: counts });
  }
  return out;
}

/** Whether to cluster: as asked, or from CLUSTER_MIN markers up; never past CLUSTER_MAX_ZOOM. */
export const shouldCluster = (mode: boolean | "auto", n: number, zoom: number) =>
  zoom < CLUSTER_MAX_ZOOM && (mode === "auto" ? n >= CLUSTER_MIN : mode) && n > 1;

const WORD: Record<ClusterTone, string> = { default: "", success: "good", warning: "warning", danger: "problem" };

/** A cluster's accessible name: how many places and their statuses, worst first, and what Enter does. */
export function clusterName(g: Extract<Group, { kind: "many" }>): string {
  const parts = (["danger", "warning", "success"] as const).flatMap((t) => (g.tones[t] ? [`${g.tones[t]} ${WORD[t]}`] : []));
  return `${g.members.length} places${parts.length ? `, ${parts.join(", ")}` : ""}. Zoom in to see them`;
}
