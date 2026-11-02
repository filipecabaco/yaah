// The data side of agent-built UI: a tree of `{ type, props, children }` nodes
// (plus `each`/`if` wrappers) with `{{bindings}}` resolved against props. Pure
// functions over `unknown`, so the renderer never trusts the agent's shapes.
import { asArray, asObj, isObj, show, type Obj } from "@/lib/narrow";

export type Scope = Obj;

const EXACT = /^\{\{\s*([\w.-]+)\s*\}\}$/;
const ANY = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** `a.b.0.c` in scope, through own properties only (never the prototype chain). */
export function lookup(scope: Scope, path: string): unknown {
  let v: unknown = scope;
  for (const k of path.split(".")) {
    if (!(isObj(v) || Array.isArray(v)) || !Object.hasOwn(v, k)) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/** Resolve bindings anywhere inside a value. `"{{x}}"` keeps x's type; `"a {{x}}"` is text. */
export function resolve(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") {
    const exact = EXACT.exec(value);
    if (exact) return lookup(scope, exact[1]);
    return value.replace(ANY, (_, path: string) => show(lookup(scope, path)));
  }
  if (Array.isArray(value)) return value.map((v: unknown) => resolve(v, scope));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, scope)]));
  return value;
}

/** A node's props with bindings resolved, always an object. */
export const resolveProps = (props: unknown, scope: Scope): Obj => asObj(resolve(props ?? {}, scope));

/** `if` semantics: empty lists are false, like empty strings. */
export const truthy = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : !!v);

/** The branch an `if` node takes. */
export const branch = (node: Obj, scope: Scope): unknown[] => asArray(truthy(lookup(scope, show(node.if))) ? node.children : node.else);

/**
 * One scope per item of an `each` node, keyed for React: by the item field
 * named in `key` (so UI state follows an item when the list reorders), else
 * by position. Duplicate keys get the position appended.
 */
export function eachScopes(node: Obj, scope: Scope): { key: string; scope: Scope }[] {
  const items = lookup(scope, show(node.each));
  if (!Array.isArray(items)) return [];
  const as = typeof node.as === "string" && node.as ? node.as : "item";
  const index = typeof node.index === "string" && node.index ? node.index : null;
  const keyField = typeof node.key === "string" ? node.key : null;
  const seen = new Set<string>();
  return items.map((item: unknown, i) => {
    const field = keyField && isObj(item) ? item[keyField] : undefined;
    let key = field == null ? String(i) : show(field);
    if (seen.has(key)) key = `${key}#${i}`;
    seen.add(key);
    return { key, scope: { ...scope, [as]: item, ...(index ? { [index]: i } : {}) } };
  });
}

/** The `tab` nodes under `tabs`, looking through `if`/`each` wrappers, each with its scope. */
export function collectTabs(nodes: unknown[], scope: Scope): { tab: Obj; scope: Scope }[] {
  return nodes.flatMap((n) => {
    if (!isObj(n)) return [];
    if (n.type === "tab") return [{ tab: n, scope }];
    if ("if" in n) return collectTabs(branch(n, scope), scope);
    if ("each" in n) return eachScopes(n, scope).flatMap((e) => collectTabs(asArray(n.children), e.scope));
    return [];
  });
}

/** Names of required fields under a form node (inputs with `required` and a literal `name`). */
export function requiredFields(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isObj(n)) return;
    const p = asObj(n.props);
    if (p.required && typeof p.name === "string") out.push(p.name);
    walk(n.children);
    walk(n.else);
  };
  walk(asObj(node).children);
  return out;
}
