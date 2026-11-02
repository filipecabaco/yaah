// App-wide requests that cross the component tree without props: a card deep
// in a chat asking the app to open Settings on a tab.
const OPEN_SETTINGS = "yaah:open-settings";

/** Ask the app to open Settings on a tab (App listens). */
export function openSettings(tab: string) {
  window.dispatchEvent(new CustomEvent<string>(OPEN_SETTINGS, { detail: tab }));
}

export function onOpenSettings(cb: (tab: string) => void): () => void {
  const listener = (e: Event) => cb((e as CustomEvent<string>).detail);
  window.addEventListener(OPEN_SETTINGS, listener);
  return () => window.removeEventListener(OPEN_SETTINGS, listener);
}
