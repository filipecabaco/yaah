// App-wide requests that cross the component tree without props: a card deep
// in a chat asking the app to open Settings on a tab, a component in the library,
// or one of its UIs in a side pane.
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

const ADD_REPOS = "yaah:add-repos";
type AddRepos = { sessionId: string; pane?: string };

/**
 * Ask a chat to open its repo picker, to add repos as it goes (⌘K, `/repos`, the header's
 * folder menu). `pane`: the split pane it was asked from, when the chat is open in several.
 */
export function openAddRepos(sessionId: string, pane?: string) {
  window.dispatchEvent(new CustomEvent<AddRepos>(ADD_REPOS, { detail: { sessionId, pane } }));
}

export function onOpenAddRepos(cb: (request: AddRepos) => void): () => void {
  const listener = (e: Event) => cb((e as CustomEvent<AddRepos>).detail);
  window.addEventListener(ADD_REPOS, listener);
  return () => window.removeEventListener(ADD_REPOS, listener);
}

const COMPOSER_CONFIG = "yaah:composer-config";
/** The composer's pickers (components/composer-config.tsx). */
export type ConfigRole = "model" | "effort";
type ComposerConfigRequest = { sessionId: string; role: ConfigRole; pane?: string };

/** Ask a chat's composer to open its Model or Effort picker (⌘K "Change model…"). `pane`: where it was asked from. */
export function openComposerConfig(sessionId: string, role: ConfigRole, pane?: string) {
  window.dispatchEvent(new CustomEvent<ComposerConfigRequest>(COMPOSER_CONFIG, { detail: { sessionId, role, pane } }));
}

export function onOpenComposerConfig(cb: (request: ComposerConfigRequest) => void): () => void {
  const listener = (e: Event) => cb((e as CustomEvent<ComposerConfigRequest>).detail);
  window.addEventListener(COMPOSER_CONFIG, listener);
  return () => window.removeEventListener(COMPOSER_CONFIG, listener);
}

const CYCLE_MODE = "yaah:cycle-mode";
export type CycleModeRequest = { sessionId: string; pane?: string };

/** Shift+Tab in a composer: ask that chat's mode picker for the next safe permission mode. */
export function cycleMode(sessionId: string, pane?: string) {
  window.dispatchEvent(new CustomEvent<CycleModeRequest>(CYCLE_MODE, { detail: { sessionId, pane } }));
}

export function onCycleMode(cb: (request: CycleModeRequest) => void): () => void {
  const listener = (e: Event) => cb((e as CustomEvent<CycleModeRequest>).detail);
  window.addEventListener(CYCLE_MODE, listener);
  return () => window.removeEventListener(CYCLE_MODE, listener);
}

const OPEN_UI_PANE = "yaah:open-ui-pane";
/** A chat's UI entry (`index` in chat `chat`) to move into a side pane; `pane`: the pane it was asked from. */
export type UiPaneRequest = { chat: string; index: number; pane?: string };

/** Move a rendered UI into a pane beside its chat, as the agent's `ui_open_pane` does (App listens). */
export function openUiPane(request: UiPaneRequest) {
  window.dispatchEvent(new CustomEvent<UiPaneRequest>(OPEN_UI_PANE, { detail: request }));
}

export function onOpenUiPane(cb: (request: UiPaneRequest) => void): () => void {
  const listener = (e: Event) => cb((e as CustomEvent<UiPaneRequest>).detail);
  window.addEventListener(OPEN_UI_PANE, listener);
  return () => window.removeEventListener(OPEN_UI_PANE, listener);
}
