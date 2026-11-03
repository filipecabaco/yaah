---
name: yaah-components
description: Build, save and improve reusable UI components in yaah's component library with ui_save_component. Covers the props JSON Schema, the tree with {{bindings}}, examples, versions and installed component libraries. Use it inside yaah when a UI shape will come up again (a status panel, a review card, a checklist, a report) or when asked to save, change or reuse a component.
---

# Reusable components in yaah

A component is data: a tree of yaah's primitives (and other components) with `{{bindings}}` to its props, a JSON Schema for those props, and examples. Saved components go into the user's own collection (`~/.yaah/components/`), are shared by every chat and every agent, keep their version history, and show on the Component library page.

## The tools

Where MCP tools are prefixed by server (Claude Code) they are `mcp__yaah-ui__ui_save_component`, `mcp__yaah-ui__ui_get_component`, `mcp__yaah-ui__ui_catalog` and `mcp__yaah-ui__ui_render`; elsewhere the bare `ui_save_component`, `ui_get_component`, `ui_catalog` and `ui_render`. Call the exact name your tool list shows.

## Before saving

- Call `ui_catalog` and reuse what is there. Improve an existing component of the user's (`ui_get_component`, then save with `expectedVersion`) instead of making a near-duplicate.
- yaah's own components (source `yaah`) and installed libraries' components (`library/name`) are read-only: compose them inside yours, or save a variant under a new unqualified name.
- Save only shapes that will come up again. For a one-off, pass a `tree` to `ui_render`.

## A save

```json
{
  "name": "release-checklist",
  "description": "A release's checklist: each step with its owner and done/pending badge, and how many are done. Use when planning or tracking a release.",
  "props": {
    "type": "object",
    "properties": {
      "version": { "type": "string", "description": "e.g. v1.4.0" },
      "steps": { "type": "array", "description": "[{ id, title, owner, done }]" }
    },
    "required": ["version", "steps"]
  },
  "tree": { "type": "card", "props": { "title": "Release {{version}}" }, "children": [
    { "each": "steps", "as": "step", "key": "id", "children": [
      { "type": "stack", "props": { "direction": "row", "justify": "between" }, "children": [
        { "type": "text", "props": { "text": "{{step.title}} · {{step.owner}}" } },
        { "if": "step.done",
          "children": [{ "type": "badge", "props": { "text": "done" } }],
          "else": [{ "type": "badge", "props": { "text": "pending", "variant": "outline" } }] }
      ] }
    ] }
  ] },
  "examples": [
    { "title": "Half way", "props": { "version": "v1.4.0", "steps": [
      { "id": "notes", "title": "Write release notes", "owner": "Ada", "done": true },
      { "id": "tag", "title": "Tag the release", "owner": "Lin", "done": false }
    ] } }
  ]
}
```

- **name**: kebab-case, 2-48 characters, unqualified, not a primitive's name.
- **description**: what it shows and when to use it. Agents choose components by this text, so be precise.
- **props**: a JSON Schema object (`type: "object"`, `properties`, `required`). Describe array items in the property's `description`.
- **tree**: an object, never a string. `"{{path}}"` alone passes the value through with its type (arrays, numbers); inside a longer string it is inserted as text. `each` repeats (give `key` when items can change), `if`/`else` chooses, and another component is a node `{ "type": "other-component", "props": { … } }`.
- **examples**: at least one, each `{ "title", "props" }`, and each must fit the schema. The first is rendered in the chat as a preview (`"preview": false` to skip it).
- Limits: 3000 nodes, depth 30, 8 levels of nested components, no cycles.

## Versions

Every save makes a new version; the old one stays in history. To change a component:

1. `ui_get_component { "name" }` to read it and its `version`;
2. `ui_save_component` with the whole new component, `expectedVersion` set to the version you read, and a `changeNote` saying what changed and why.

If someone saved in between, the save is refused: read it again and reapply your change.

## Rendering

`ui_render { "component": "release-checklist", "props": { … }, "id": "release" }`. With an `id`, rendering again updates it in place, so a checklist can tick off steps as you go. A component containing a `form` can be used with `ui_ask`.

## Component libraries

Installed libraries add components named `library/name`, listed in `ui_catalog` with their `source`. They are read-only. To change one, copy it: read it with `ui_get_component`, save it under an unqualified name, then edit the copy (it can keep using `library/…` components). Inside a library, components refer to their own library's components by qualified name.

## When a save is refused

The errors name each problem by its path, e.g. `examples[0].title is required`, an unknown prop at `tree.children[1]`, an example that doesn't fit the schema (`examples[0].props`). Clients that read structured results get them as `structuredContent.errors`, each `{ path, message }`. Fix exactly those and save again. Don't resend the same arguments. Send `tree`, `props` and `examples` as JSON objects (a JSON-encoded string is accepted, plain text is not).
