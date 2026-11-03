// App-wide requests that cross the component tree without props: a card deep
// in a chat asking the app to open Settings on a tab, or a component in the library.
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

const OPEN_COMPONENT = "yaah:open-component";

/** Ask the app to show a component on the Component library page (App listens). */
export function openComponent(name: string) {
  window.dispatchEvent(new CustomEvent<string>(OPEN_COMPONENT, { detail: name }));
}

export function onOpenComponent(cb: (name: string) => void): () => void {
  const listener = (e: Event) => cb((e as CustomEvent<string>).detail);
  window.addEventListener(OPEN_COMPONENT, listener);
  return () => window.removeEventListener(OPEN_COMPONENT, listener);
}

const SWITCH_AGENT = "yaah:switch-agent";

/** Ask the app to show the agent picker for a chat's next message (App opens the ⌘K palette on it). */
export function openAgentSwitch(sessionId: string) {
  window.dispatchEvent(new CustomEvent<string>(SWITCH_AGENT, { detail: sessionId }));
}

export function onOpenAgentSwitch(cb: (sessionId: string) => void): () => void {
  const listener = (e: Event) => cb((e as CustomEvent<string>).detail);
  window.addEventListener(SWITCH_AGENT, listener);
  return () => window.removeEventListener(SWITCH_AGENT, listener);
}
