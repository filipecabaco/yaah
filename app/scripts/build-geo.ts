// Builds the map geometry the `map` primitive bundles (src/assets/geo/*.topo.json) and the region
// id list Rust validates against (src/assets/geo/region-ids.json), from pinned npm packages:
//   world-atlas 2.0.2 (Natural Earth, public domain), us-atlas 3.0.1 (US Census Bureau),
//   i18n-iso-countries 7.14.0 (ISO 3166-1 codes and English names, MIT).
// Run after upgrading any of them, and commit the output:
//   pnpm geo
// (Node, not Elixir, like build-themes.ts: it reads npm packages' TopoJSON and writes TopoJSON.)
//
// Each region set keeps only what the map draws: geometry ids rewritten to the canonical id (ISO
// 3166-1 alpha-3 for countries, the postal code for US states), `properties` cut to the name and
// the other codes, unused arcs pruned. `europe` comes from the 50m countries (110m drops Malta,
// Luxembourg, Andorra and others), with every point clamped to a box round Europe: Russia, Turkey
// and the overseas parts of France, Portugal and Spain collapse onto its edge instead of blowing
// out the fit. Countries outside Europe that reach into the box stay as unaddressable `context` land.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { geoArea } from "d3-geo";
import type { Polygon } from "geojson";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mod = (p: string) => join(here, "../node_modules", p);
const out = join(here, "../src/assets/geo");
const read = <T>(p: string): T => JSON.parse(readFileSync(mod(p), "utf8")) as T;

type Arc = [number, number][];
type Geometry = { type: string; arcs?: unknown; id?: string; properties?: Record<string, unknown> };
type Topology = {
  type: "Topology";
  bbox?: number[];
  transform?: { scale: [number, number]; translate: [number, number] };
  objects: Record<string, { type: "GeometryCollection"; geometries: Geometry[] }>;
  arcs: Arc[];
};

// ── ISO 3166-1 ───────────────────────────────────────────────────────────────

const codes = read<[string, string, string, string][]>("i18n-iso-countries/codes.json");
const en = read<{ countries: Record<string, string | string[]> }>("i18n-iso-countries/langs/en.json").countries;
const byNumeric = new Map(codes.map(([a2, a3, num]) => [num, { a2, a3, num }]));
const namesOf = (a2: string): string[] => {
  const n = en[a2];
  return n == null ? [] : Array.isArray(n) ? n : [n];
};
/** Short names people write, where ISO's first English name is the long form. */
const DISPLAY: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  RU: "Russia",
  KR: "South Korea",
  KP: "North Korea",
  IR: "Iran",
  SY: "Syria",
  LA: "Laos",
  TZ: "Tanzania",
  MD: "Moldova",
  MK: "North Macedonia",
  PS: "Palestine",
  TW: "Taiwan",
  VA: "Vatican City",
  CD: "DR Congo",
  CG: "Congo",
  CZ: "Czechia",
  CI: "Côte d'Ivoire",
  BO: "Bolivia",
  VE: "Venezuela",
  BN: "Brunei",
  VN: "Vietnam",
  FK: "Falkland Islands",
  FM: "Micronesia",
  XK: "Kosovo",
};
/** Names the doc asks for that ISO's list doesn't have. */
const EXTRA_ALIASES: Record<string, string[]> = { US: ["America"], GB: ["Britain", "England"], NL: ["Holland"], CZ: ["Czech"], XK: ["Kosova"] };

type CountryRow = { id: string; name: string; a2: string; num: string; aliases: string[] };
function country(numeric: string | undefined, atlasName: string): CountryRow | null {
  // Kosovo has no ISO code: XKX / XK are the user-assigned codes in common use.
  const iso = numeric ? byNumeric.get(numeric) : atlasName === "Kosovo" ? { a2: "XK", a3: "XKX", num: "" } : undefined;
  if (!iso) return null;
  const names = iso.a2 === "XK" ? ["Kosovo"] : namesOf(iso.a2);
  const name = DISPLAY[iso.a2] ?? names.find((n) => !/[,(]/.test(n)) ?? atlasName;
  const aliases = [...new Set([...names, atlasName, ...(EXTRA_ALIASES[iso.a2] ?? [])])].filter((n) => n !== name);
  return { id: iso.a3, name, a2: iso.a2, num: iso.num, aliases };
}

// ── US states ────────────────────────────────────────────────────────────────

const POSTAL: Record<string, string> = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
  "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME",
  "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
  "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
  "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI",
  "56": "WY",
}; // prettier-ignore

// ── topology helpers ─────────────────────────────────────────────────────────

/** Arcs as absolute (still quantized) points. */
const decode = (t: Topology): Arc[] =>
  t.arcs.map((arc) => {
    if (!t.transform) return arc.map(([x, y]) => [x, y] as [number, number]);
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => [(x += dx), (y += dy)] as [number, number]);
  });
const encode = (arcs: Arc[]): Arc[] =>
  arcs.map((arc) => {
    let px = 0;
    let py = 0;
    return arc.map(([x, y]) => {
      const d: [number, number] = [x - px, y - py];
      [px, py] = [x, y];
      return d;
    });
  });

/** Every arc index a geometry's `arcs` names (negative ones are ~index, reversed). */
function arcIndices(arcs: unknown, into: Set<number>) {
  if (typeof arcs === "number") into.add(arcs < 0 ? ~arcs : arcs);
  else if (Array.isArray(arcs)) for (const a of arcs) arcIndices(a, into);
}
function remapArcs(arcs: unknown, map: Map<number, number>): unknown {
  if (typeof arcs === "number") return arcs < 0 ? ~map.get(~arcs)! : map.get(arcs)!;
  return Array.isArray(arcs) ? arcs.map((a) => remapArcs(a, map)) : arcs;
}

/** A topology with only `objects`, its arcs renumbered and the unused ones gone. */
function prune(t: Topology, objects: Topology["objects"], arcs: Arc[]): Topology {
  const used = new Set<number>();
  for (const o of Object.values(objects)) for (const g of o.geometries) arcIndices(g.arcs, used);
  const order = [...used].sort((a, b) => a - b);
  const map = new Map(order.map((old, i) => [old, i]));
  const outObjects = Object.fromEntries(
    Object.entries(objects).map(([k, o]) => [k, { ...o, geometries: o.geometries.map((g) => ({ ...g, arcs: remapArcs(g.arcs, map) })) }]),
  );
  const kept = order.map((i) => arcs[i]);
  return { type: "Topology", transform: t.transform, objects: outObjects, arcs: t.transform ? encode(kept) : kept };
}

/** Quantized point → lon/lat. */
const toLonLat = (t: Topology, [x, y]: [number, number]): [number, number] =>
  t.transform ? [x * t.transform.scale[0] + t.transform.translate[0], y * t.transform.scale[1] + t.transform.translate[1]] : [x, y];
const fromLonLat = (t: Topology, [lon, lat]: [number, number]): [number, number] =>
  t.transform
    ? [Math.round((lon - t.transform.translate[0]) / t.transform.scale[0]), Math.round((lat - t.transform.translate[1]) / t.transform.scale[1])]
    : [lon, lat];

/** The lon/lat box of a geometry, from its arcs. */
function bboxOf(t: Topology, arcs: Arc[], g: Geometry): [number, number, number, number] {
  const ids = new Set<number>();
  arcIndices(g.arcs, ids);
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const i of ids)
    for (const p of arcs[i]) {
      const [lon, lat] = toLonLat(t, p);
      [w, s, e, n] = [Math.min(w, lon), Math.min(s, lat), Math.max(e, lon), Math.max(n, lat)];
    }
  return [w, s, e, n];
}

/** Douglas–Peucker over one arc: its ends always stay. */
function simplify(pts: [number, number][], tolerance: number): [number, number][] {
  if (pts.length <= 2) return pts;
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let far = -1;
    let at = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > far) [far, at] = [d, i];
    }
    if (far > tolerance) {
      keep[at] = true;
      stack.push([a, at], [at, b]);
    }
  }
  // A closed arc (an island drawn as one arc) keeps at least a triangle.
  const out = pts.filter((_, i) => keep[i]);
  return out.length < 4 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1] ? pts : out;
}

/** A ring (a list of arc indices) as lon/lat points, in order. */
function ringPoints(t: Topology, arcs: Arc[], ring: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const i of ring) {
    const a = i < 0 ? [...arcs[~i]].reverse() : arcs[i];
    for (const [k, p] of a.entries()) if (k > 0 || !out.length) out.push(toLonLat(t, p));
  }
  return out;
}
const planarArea = (pts: [number, number][]) =>
  Math.abs(pts.reduce((s, [x, y], i) => s + x * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * y, 0)) / 2;
/** The same ring the other way round. */
const rewind = (ring: number[]) => [...ring].reverse().map((i) => ~i);

/**
 * After clamping: polygons that collapsed onto the box edge (overseas parts) are dropped, and a
 * ring d3-geo would read as everything outside it (more than half the sphere) is turned round.
 * Null when nothing of the geometry is left.
 */
function repair(t: Topology, original: Arc[], arcs: Arc[], g: Geometry): Geometry | null {
  const polygons = (g.type === "Polygon" ? [g.arcs] : (g.arcs as number[][][])) as number[][][];
  // Collapsed: clamping left under a tenth of the ring (tiny states like Monaco are never clamped, so they stay).
  const alive = (r: number[]) => planarArea(ringPoints(t, arcs, r)) > 0.1 * planarArea(ringPoints(t, original, r));
  const kept = polygons.flatMap((rings) => {
    const [outer, ...holes] = rings.filter(alive);
    if (!outer || rings[0] !== outer) return [];
    const right = (r: number[]) =>
      geoArea({ type: "Polygon", coordinates: [ringPoints(t, arcs, r)] } satisfies Polygon) > 2 * Math.PI ? rewind(r) : r;
    return [[right(outer), ...holes.map((h) => rewind(right(rewind(h))))]];
  });
  if (!kept.length) return null;
  return kept.length === 1 ? { ...g, type: "Polygon", arcs: kept[0] } : { ...g, type: "MultiPolygon", arcs: kept };
}

const nameOf = (g: Geometry) => (typeof g.properties?.name === "string" ? g.properties.name : "");

const write = (name: string, value: unknown) => {
  const text = JSON.stringify(value);
  writeFileSync(join(out, name), text + "\n");
  console.log(`${name}: ${(text.length / 1024).toFixed(1)} KB`);
};
mkdirSync(out, { recursive: true });

// ── world (110m) ─────────────────────────────────────────────────────────────

const ids: Record<string, unknown[]> = {};
{
  const t = read<Topology>("world-atlas/countries-110m.json");
  const rows: CountryRow[] = [];
  const geometries = t.objects.countries.geometries.map((g) => {
    const name = nameOf(g);
    const c = country(g.id, name);
    // Antarctica is land on a world map, not a country a value belongs to (it would be a big hatched "no data").
    if (!c || c.id === "ATA") return { type: g.type, arcs: g.arcs, properties: { name } };
    rows.push(c);
    return { type: g.type, arcs: g.arcs, id: c.id, properties: { name: c.name, a2: c.a2, ...(c.num ? { num: c.num } : {}) } };
  });
  write("world.topo.json", prune(t, { regions: { type: "GeometryCollection", geometries } }, decode(t)));
  ids.world = rows.sort((a, b) => a.id.localeCompare(b.id));
}

// ── world (50m, for zoomed views) ───────────────────────────────────────────

// The same countries in more detail, drawn only when a world map is zoomed in (map/geo.ts
// loads it then). Its ids are the 110m set's, so validation (region-ids.json) stays one list;
// the countries 110m has no shape for (Malta, Andorra…) stay plain land here.
{
  const t = read<Topology>("world-atlas/countries-50m.json");
  const known = new Set((ids.world as CountryRow[]).map((r) => r.id));
  const regions: Geometry[] = [];
  const context: Geometry[] = [];
  for (const g of t.objects.countries.geometries) {
    const name = nameOf(g);
    const c = country(g.id, name);
    if (c && known.has(c.id))
      regions.push({ type: g.type, arcs: g.arcs, id: c.id, properties: { name: c.name, a2: c.a2, ...(c.num ? { num: c.num } : {}) } });
    else context.push({ type: g.type, arcs: g.arcs, properties: { name: c?.name ?? name } });
  }
  write(
    "world-50m.topo.json",
    prune(
      t,
      { regions: { type: "GeometryCollection", geometries: regions }, context: { type: "GeometryCollection", geometries: context } },
      decode(t),
    ),
  );
}

// ── europe (50m, clamped) ────────────────────────────────────────────────────

/** Geographic Europe, plus Cyprus, Türkiye and the Caucasus, which European datasets (Eurostat, UEFA, Eurovision) often include. */
const EUROPE = new Set(
  (
    "ALB AND ARM AUT AZE BEL BGR BIH BLR CHE CYP CZE DEU DNK ESP EST FIN FRA GBR GEO GRC HRV HUN IRL ISL ITA LIE LTU LUX LVA MCO MDA " +
    "MKD MLT MNE NLD NOR POL PRT ROU RUS SMR SRB SVK SVN SWE TUR UKR VAT XKX FRO IMN JEY GGY ALA"
  ).split(" "),
);
/**
 * West, south, east, north: well outside the frame the map shows (map/projection.ts FRAME), so
 * the clamped edges never come into view, even when a bubble map widens to the Azores.
 */
const EUROPE_BOX = [-60, 15, 100, 84] as const;
{
  const t = read<Topology>("world-atlas/countries-50m.json");
  const arcs = decode(t);
  const [w, s, e, n] = EUROPE_BOX;
  const lo = fromLonLat(t, [w, s]);
  const hi = fromLonLat(t, [e, n]);
  const rows: CountryRow[] = [];
  const regions: Geometry[] = [];
  const context: Geometry[] = [];
  for (const g of t.objects.countries.geometries) {
    const name = nameOf(g);
    const c = country(g.id, name);
    const [gw, gs, ge, gn] = bboxOf(t, arcs, g);
    const inBox = gw < e && ge > w && gs < n && gn > s;
    if (c && EUROPE.has(c.id)) {
      rows.push(c);
      regions.push({ type: g.type, arcs: g.arcs, id: c.id, properties: { name: c.name, a2: c.a2, ...(c.num ? { num: c.num } : {}) } });
    } else if (inBox) context.push({ type: g.type, arcs: g.arcs, properties: { name: c?.name ?? name } });
  }
  // Clamp every point into the box (shared arc ends clamp alike, so rings stay closed), then drop repeats.
  // Then simplify each arc's inside (its ends stay, so neighbours still share them) to about 1.5 km.
  const tolerance = 0.015 / t.transform!.scale[0];
  const clamped = arcs.map((arc) => {
    const pts = arc.map(([x, y]) => [Math.min(hi[0], Math.max(lo[0], x)), Math.min(hi[1], Math.max(lo[1], y))] as [number, number]);
    const kept = simplify(
      pts.filter((p, i) => i === 0 || i === pts.length - 1 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]),
      tolerance,
    );
    return kept.length >= 2 ? kept : [pts[0], pts[pts.length - 1]];
  });
  const fixed = [...regions, ...context].map((g) => repair(t, arcs, clamped, g));
  const objects = {
    regions: { type: "GeometryCollection" as const, geometries: fixed.slice(0, regions.length).filter((g): g is Geometry => g != null) },
    context: { type: "GeometryCollection" as const, geometries: fixed.slice(regions.length).filter((g): g is Geometry => g != null) },
  };
  write("europe.topo.json", prune(t, objects, clamped));
  ids.europe = rows.sort((a, b) => a.id.localeCompare(b.id));
}

// ── us-states (Albers USA, already projected) ────────────────────────────────

{
  const t = read<Topology>("us-atlas/states-albers-10m.json");
  const rows: { id: string; name: string; fips: string; aliases: string[] }[] = [];
  const geometries = t.objects.states.geometries.map((g) => {
    const fips = String(g.id);
    const postal = POSTAL[fips];
    const name = nameOf(g);
    if (!postal) throw new Error(`no postal code for FIPS ${fips} (${name})`);
    rows.push({ id: postal, name, fips, aliases: postal === "DC" ? ["D.C.", "Washington DC", "Washington, D.C."] : [] });
    return { type: g.type, arcs: g.arcs, id: postal, properties: { name, fips } };
  });
  const topo = prune(t, { regions: { type: "GeometryCollection", geometries } }, decode(t));
  // Already in pixels (Albers USA at scale 1300 in a 975×610 box): the renderer fits it with geoIdentity.
  write("us-states.topo.json", { ...topo, bbox: t.bbox });
  ids["us-states"] = rows.sort((a, b) => a.id.localeCompare(b.id));
}

write("region-ids.json", ids);
