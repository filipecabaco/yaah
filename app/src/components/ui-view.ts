// How agent-built UI is being shown: inline in the transcript, or expanded in
// a large dialog (UiEntry's Expand). Blocks with a fixed inline height read
// `expanded` to fill the dialog instead; `expand` opens it from inside a block
// (diff-review's header).
import { createContext, useContext } from "react";

export type UiView = {
  /** Shown in the expanded dialog: fill the height there instead of a fixed inline cap. */
  expanded: boolean;
  /** Open this UI expanded; unset when it can't be (or already is). */
  expand?: () => void;
};

export const UiViewContext = createContext<UiView>({ expanded: false });
export const useUiView = () => useContext(UiViewContext);

/** `inline` (a max-height class) when shown inline; no cap when expanded, so the dialog scrolls instead. */
export const inlineMax = (expanded: boolean, inline: string) => (expanded ? "max-h-none" : inline);
