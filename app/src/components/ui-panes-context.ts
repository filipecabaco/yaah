// Which of a chat's rendered UIs are moved out into side panes (layout.ts `ui` panes), for the
// transcript: an entry shown in a pane leaves a link behind instead of its content. App provides
// it from the layout (hooks/use-side-panes.ts); outside the app nothing is ever in a pane.
import { createContext, useContext } from "react";

export type UiPanes = {
  /** The pane showing chat `chat`'s UI at transcript `index`, if one does. */
  paneOf: (chat: string, index: number) => string | undefined;
  /** Bring that pane to the keyboard. */
  focus: (pane: string) => void;
  /** Close it: the UI goes back into its chat. */
  close: (pane: string) => void;
};

const NONE: UiPanes = { paneOf: () => undefined, focus: () => undefined, close: () => undefined };

export const UiPanesContext = createContext<UiPanes>(NONE);
export const useUiPanes = () => useContext(UiPanesContext);
