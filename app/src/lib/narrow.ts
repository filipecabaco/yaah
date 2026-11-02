// Small, typed narrowing for data the app doesn't control: agent-built UI
// props, recorded fixtures, JSON from a source. Values come in as `unknown`
// and are read through these instead of `any`.

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The object, or an empty one. */
export const asObj = (v: unknown): Obj => (isObj(v) ? v : {});

/** The array, or an empty one. */
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

/** The array if it is one, else undefined (for "absent" vs "empty"). */
export const optArray = (v: unknown): unknown[] | undefined => (Array.isArray(v) ? (v as unknown[]) : undefined);

export const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A finite number from a number or a numeric string. */
export function asNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Text for display: strings as they are, objects as JSON, nothing for null. */
export function show(v: unknown): string {
  switch (typeof v) {
    case "string":
      return v;
    case "number":
    case "boolean":
    case "bigint":
      return String(v);
    case "object":
      return v === null ? "" : JSON.stringify(v);
    default:
      return "";
  }
}

/** `show`, but undefined for a missing or empty value (an optional label). */
export const optText = (v: unknown): string | undefined => (v == null || v === "" ? undefined : show(v));

/** A readable message from whatever a failed promise rejected with (Tauri commands reject with strings). */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (isObj(e) && typeof e.message === "string") return e.message;
  return show(e) || "Something went wrong.";
}
