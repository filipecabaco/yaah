import { describe, expect, it } from "vitest";
import liveUi from "@/dev/fixtures/live-ui.json";
import { branch, collectTabs, eachScopes, lookup, requiredFields, resolve, resolveProps } from "@/components/ui-bindings";
import { asArray, asObj, isObj, type Obj } from "@/lib/narrow";

// The component Claude built and rendered in the recorded `live_ui` run.
const rendered = asObj((liveUi as { payload: { entry?: { type: string } } }[]).find((e) => e.payload.entry?.type === "ui")?.payload.entry);
const component = asObj(rendered.tree);

/** Depth-first search for the first node of a type. */
function find(node: unknown, type: string): Obj | undefined {
  if (!isObj(node)) return undefined;
  if (node.type === type) return node;
  for (const c of [...asArray(node.children), node.tree]) {
    const hit = find(c, type);
    if (hit) return hit;
  }
}

describe("binding resolution on a recorded component", () => {
  const scope = resolveProps(component.props, {});

  it("a library component gets its own props", () => {
    expect(component.type).toBe("$component");
    expect(scope.title).toBe("Service status");
    expect(asArray(scope.services)).toHaveLength(3);
  });

  it('"{{x}}" keeps the value\'s type; text bindings become text', () => {
    const grid = find(component.tree, "grid")!;
    expect(resolveProps(grid.props, scope)).toEqual({ columns: 3, gap: "md" });
    const each = asArray(grid.children)[0] as Obj;
    const items = eachScopes(each, scope);
    expect(items.map((i) => i.key)).toEqual(["0", "1", "2"]);
    const card = find(each, "card")!;
    expect(items.map((i) => resolveProps(card.props, i.scope).title)).toEqual(["api", "worker", "billing"]);
    const text = find(card, "text")!;
    expect(resolveProps(text.props, items[1].scope)).toEqual({ text: "● Degraded", tone: "warning", weight: "semibold" });
  });

  it("`if` takes its branch from the scope", () => {
    const heading = asArray(asObj(component.tree).children)[0] as Obj;
    expect(branch(heading, scope)).toHaveLength(1);
    expect(branch(heading, { ...scope, title: "" })).toHaveLength(0);
  });
});

describe("lookup", () => {
  it("walks objects and arrays by own properties only", () => {
    const scope = { a: { b: [10, { c: "x" }] } };
    expect(lookup(scope, "a.b.1.c")).toBe("x");
    expect(lookup(scope, "a.b.length")).toBe(2);
    expect(lookup(scope, "a.missing.c")).toBeUndefined();
    expect(lookup(scope, "constructor")).toBeUndefined();
    expect(lookup(scope, "a.__proto__")).toBeUndefined();
    expect(lookup(scope, "a.b.0.toFixed")).toBeUndefined();
  });
});

describe("resolve", () => {
  it("resolves inside nested values and stringifies objects in text", () => {
    const scope = { n: 3, user: { name: "Ada" }, tags: ["a", "b"] };
    expect(resolve({ x: ["{{n}}", "n={{n}}"], y: { z: "{{user}}" } }, scope)).toEqual({ x: [3, "n=3"], y: { z: { name: "Ada" } } });
    expect(resolve("{{ user.name }} has {{tags}}", scope)).toBe('Ada has ["a","b"]');
    expect(resolve("{{nope}}!", scope)).toBe("!");
    expect(resolve(7, scope)).toBe(7);
  });
});

describe("each", () => {
  it("keys by a field when asked, de-duplicating", () => {
    const node = { each: "rows", as: "r", index: "i", key: "id", children: [] };
    const scopes = eachScopes(node, { rows: [{ id: "a" }, { id: "b" }, { id: "a" }, {}] });
    expect(scopes.map((s) => s.key)).toEqual(["a", "b", "a#2", "3"]);
    expect(scopes[1].scope).toMatchObject({ r: { id: "b" }, i: 1 });
    expect(eachScopes(node, { rows: "not a list" })).toEqual([]);
  });
});

describe("collectTabs", () => {
  it("finds tabs through if and each", () => {
    const nodes = [
      { type: "tab", props: { label: "One" } },
      { if: "more", children: [{ type: "tab", props: { label: "Two" } }], else: [] },
      { each: "extra", as: "x", children: [{ type: "tab", props: { label: "{{x}}" } }] },
      "stray text",
    ];
    const tabs = collectTabs(nodes, { more: true, extra: ["Three", "Four"] });
    expect(tabs.map((t) => resolve(asObj(t.tab.props).label, t.scope))).toEqual(["One", "Two", "Three", "Four"]);
  });
});

describe("requiredFields", () => {
  it("collects literal names of required inputs anywhere under a form", () => {
    const form = {
      type: "form",
      children: [
        { type: "textfield", props: { name: "title", required: true } },
        { type: "stack", children: [{ type: "choice", props: { name: "kind", required: true } }] },
        { if: "x", children: [], else: [{ type: "select", props: { name: "prio", required: true } }] },
        { type: "textfield", props: { name: "notes" } },
      ],
    };
    expect(requiredFields(form)).toEqual(["title", "kind", "prio"]);
    expect(requiredFields(null)).toEqual([]);
  });
});
