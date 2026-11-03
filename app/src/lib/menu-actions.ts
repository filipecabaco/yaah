// Actions an element offers in whichever right-click menu opens over it, so a
// part of an entry (a diff hunk in a tool card) can add to the entry's menu
// without a menu of its own. menus.tsx reads them when a menu opens.
import type { ReactNode } from "react";

/** Any action in a menu. */
export type MenuAction = { label: string; icon?: ReactNode; onSelect: () => void };

const registered = new WeakMap<Element, MenuAction[]>();

/** A ref giving right-clicks inside the element `actions`, e.g. "Ask about this" on a diff hunk. */
export function menuActions(actions: MenuAction[]) {
  return (el: HTMLElement | null) => {
    if (!el) return;
    registered.set(el, actions);
    return () => void registered.delete(el);
  };
}

/** The actions registered on `el` and its ancestors, innermost first. */
export function actionsAt(el: Element | null): MenuAction[] {
  const out: MenuAction[] = [];
  for (let n = el; n; n = n.parentElement) out.push(...(registered.get(n) ?? []));
  return out;
}
