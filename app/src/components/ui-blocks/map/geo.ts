// The bundled geometry behind region maps (src/assets/geo, built by scripts/build-geo.ts): one
// lazy chunk per region set, imported the first time a map of that set renders and cached by the
// module system. Nothing is fetched at run time. Each region carries its canonical id (ISO 3166-1
// alpha-3, or a US postal code) and the codes an agent may write instead.
import { useEffect, useState } from "react";
import { feature, mesh } from "topojson-client";
import type { Feature, Geometry, MultiLineString } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";

export type RegionSet = "world" | "europe" | "us-states";
export const REGION_SETS: readonly RegionSet[] = ["world", "europe", "us-states"];
export const REGION_NAME: Record<RegionSet, string> = { world: "the world", europe: "Europe", "us-states": "US states" };

type Props = { name?: string; a2?: string; num?: string; fips?: string };
export type Region = { id: string; name: string; codes: string[]; feature: Feature<Geometry, Props> };
export type RegionGeo = {
  set: RegionSet;
  /** Already projected to pixels (us-states: Albers USA in a 975×610 box). */
  projected: boolean;
  regions: Region[];
  byId: Map<string, Region>;
  /** Land with no id (unrecognised territories, or a neighbour drawn for context). */
  land: Feature<Geometry, Props>[];
  /** Every region boundary and coast, as one line. */
  borders: MultiLineString;
  /** Lower-cased id, code or English name → canonical id. */
  keys: Map<string, string>;
};

// `?raw` keeps TypeScript from typing 200 KB of JSON; the text is parsed once per set.
const LOADERS: Record<RegionSet, () => Promise<{ default: string }>> = {
  world: () => import("@/assets/geo/world.topo.json?raw"),
  europe: () => import("@/assets/geo/europe.topo.json?raw"),
  "us-states": () => import("@/assets/geo/us-states.topo.json?raw"),
};

/** How agents' ids are compared: case, spaces and dots don't matter ("U.S.A." is "usa"). */
export const idKey = (raw: unknown): string =>
  (typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "").trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");

type Topo = Topology<{ regions: GeometryCollection<Props>; context?: GeometryCollection<Props> }>;

export function buildGeo(set: RegionSet, topo: Topo): RegionGeo {
  const all = feature<Props>(topo, topo.objects.regions).features;
  const regions: Region[] = [];
  const land: Feature<Geometry, Props>[] = [];
  for (const f of all) {
    if (f.id == null) {
      land.push(f);
      continue;
    }
    const p = f.properties ?? {};
    regions.push({ id: String(f.id), name: p.name ?? String(f.id), codes: [p.a2, p.num, p.fips].filter((c): c is string => !!c), feature: f });
  }
  if (topo.objects.context) land.push(...feature<Props>(topo, topo.objects.context).features);
  const keys = new Map<string, string>();
  for (const r of regions) for (const k of [r.id, r.name, ...r.codes]) keys.set(idKey(k), r.id);
  const objects: GeometryCollection<Props>[] = [topo.objects.regions, ...(topo.objects.context ? [topo.objects.context] : [])];
  return {
    set,
    projected: set === "us-states",
    regions,
    byId: new Map(regions.map((r) => [r.id, r])),
    land,
    borders: { type: "MultiLineString", coordinates: objects.flatMap((o) => mesh(topo, o).coordinates) },
    keys,
  };
}

const cache = new Map<RegionSet, Promise<RegionGeo>>();
const loaded = new Map<RegionSet, RegionGeo>();
/** The region set's geometry, loading its chunk on first use (the same promise after that). */
export function loadRegion(set: RegionSet): Promise<RegionGeo> {
  let p = cache.get(set);
  if (!p) {
    p = LOADERS[set]().then((m) => {
      const geo = buildGeo(set, JSON.parse(m.default) as Topo);
      loaded.set(set, geo);
      return geo;
    });
    // A failed load (a chunk that didn't arrive) can be tried again on the next render.
    p.catch(() => cache.delete(set));
    cache.set(set, p);
  }
  return p;
}

/** The set's geometry once loaded (at once when it already is), or the load error. */
export function useRegion(set: RegionSet): RegionGeo | Error | null {
  const [state, setState] = useState<{ set: RegionSet; geo: RegionGeo | Error } | null>(null);
  const ready = loaded.get(set);
  useEffect(() => {
    if (loaded.has(set)) return;
    let live = true;
    loadRegion(set).then(
      (geo) => live && setState({ set, geo }),
      (e: unknown) => live && setState({ set, geo: e instanceof Error ? e : new Error(String(e)) }),
    );
    return () => {
      live = false;
    };
  }, [set]);
  return ready ?? (state?.set === set ? state.geo : null);
}

/**
 * A row's id as the canonical one: the id itself, a code (alpha-2, ISO numeric, FIPS) or the
 * English name, any case. Numbers are padded the way the codes are written ("42", "076").
 * Rust already rewrites literal ids; this catches values bound at render time.
 */
export function resolveId(geo: RegionGeo, raw: unknown): string | null {
  if (typeof raw === "number" && Number.isInteger(raw)) raw = String(raw).padStart(geo.set === "us-states" ? 2 : 3, "0");
  if (typeof raw !== "string" || !raw.trim()) return null;
  return geo.keys.get(idKey(raw)) ?? null;
}
