// What open panes tell the sidebar about themselves: a terminal's title, a diff's repo and change
// count. A pane publishes while it is mounted and clears on unmount, so the sidebar lists only
// what is open. View state only; the facts come from Rust.
import { useSyncExternalStore } from "react";

export type PaneInfo = { title?: string; detail?: string };

const infos = new Map<string, PaneInfo>();
const listeners = new Set<() => void>();
let version = 0;

const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

export function setPaneInfo(pane: string, info: PaneInfo) {
  const was = infos.get(pane);
  if (was && was.title === info.title && was.detail === info.detail) return;
  infos.set(pane, info);
  emit();
}

export function clearPaneInfo(pane: string) {
  if (infos.delete(pane)) emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** What pane `pane` published, if it is mounted. */
export function usePaneInfo(pane: string): PaneInfo | undefined {
  useSyncExternalStore(subscribe, () => version);
  return infos.get(pane);
}
