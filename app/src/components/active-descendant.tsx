// A combobox whose input is outside cmdk's <Command> (the composer's textarea)
// names the highlighted option through aria-activedescendant. cmdk gives each
// item an id; with a controlled `value` its own `selectedItemId` isn't kept, so
// this follows the value and reads the selected option once cmdk has drawn it.
import { useEffect, type RefObject } from "react";
import { useCommandState } from "cmdk";

/** Render inside a <Command> (`list` is its element): keeps `target`'s aria-activedescendant on the highlighted option. */
export function ActiveDescendant({ target, list }: { target: RefObject<HTMLElement | null>; list: RefObject<HTMLElement | null> }) {
  const value = useCommandState((s) => s.value);
  const count = useCommandState((s) => s.filtered.count);
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const id = list.current?.querySelector('[cmdk-item][aria-selected="true"]')?.id;
    if (id) el.setAttribute("aria-activedescendant", id);
    else el.removeAttribute("aria-activedescendant");
    return () => el.removeAttribute("aria-activedescendant");
  }, [value, count, target, list]);
  return null;
}
