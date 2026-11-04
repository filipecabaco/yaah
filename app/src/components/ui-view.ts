// How agent-built UI is being shown: inline in the transcript, or expanded in
// a large dialog (UiEntry's Expand). Blocks with a fixed inline height read
// `expanded` to fill the dialog instead; `expand` opens it from inside a block
// (diff-review's header).
import { createContext, useContext } from "react";
import { cn } from "@/lib/utils";

export type UiView = {
  /** Shown in the expanded dialog: fill the height there instead of a fixed inline cap. */
  expanded: boolean;
  /** Open this UI expanded; unset when it can't be (or already is). */
  expand?: () => void;
  /** What the UI is called (lib/ui-title.ts): blocks name their own Expand button with it. */
  name?: string;
};

export const UiViewContext = createContext<UiView>({ expanded: false });
export const useUiView = () => useContext(UiViewContext);

/**
 * The one main scrolling region of a block (a file body, a log, a tree, a list): inline it keeps its
 * `inline` cap (a max-height class); expanded it drops the cap and takes the height left in the
 * dialog (`flex-1 min-h-0`), scrolling inside itself. `stretch: false` is for content that should keep its
 * natural height when short (a tree, a short list) and only scroll when the dialog is too small. Pair with `growAttr(expanded)`, which marks it
 * so the containers around it (UiTree's `:has([data-grow])` rule) pass the height down to it.
 */
export const growClass = (expanded: boolean, inline: string, stretch = true) =>
  expanded ? cn("max-h-none min-h-0 overflow-auto", stretch ? "flex-1" : "flex-initial") : inline;
/** The marker `growClass`'s region carries while expanded (`fill` stretches, `fit` keeps its natural height). */
export const growAttr = (expanded: boolean, stretch = true) => (expanded ? { "data-grow": stretch ? "fill" : "fit" } : {});

/** `inline` (a max-height class) when shown inline; no cap when expanded, so the dialog scrolls instead. */
export const inlineMax = (expanded: boolean, inline: string) => (expanded ? "max-h-none" : inline);
