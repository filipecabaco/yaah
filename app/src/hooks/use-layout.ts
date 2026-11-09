// The window's layout as view state: the split panes (src/lib/layout.ts) and the
// sidebar. Loaded from Rust once (layout.rs, which drops panes on deleted chats
// and projects) and saved back as it changes.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { setFocusedPane } from "@/components/chat-context";
import { api, SIDEBAR, type SidebarState } from "@/lib/api";
import {
  balance,
  closePane,
  findPane,
  focusPane,
  focusedPane,
  mapContents,
  neighbour,
  nextPane,
  openBeside,
  panesOf,
  prune,
  setContent,
  setRatio,
  singlePane,
  splitPane,
  type Direction,
  type Layout,
  type Selection,
  type Split,
} from "@/lib/layout";

/** How long the layout settles before it's saved (a divider drag commits once, but keys repeat). */
const SAVE_AFTER_MS = 250;

export type Panes = ReturnType<typeof useLayout>;

export function useLayout() {
  const [layout, setLayout] = useState<Layout>(singlePane);
  const [sidebar, setSidebar] = useState<SidebarState>({ collapsed: false, width: SIDEBAR.default });
  const [loaded, setLoaded] = useState(false);
  // The latest layout, for actions that need it now (a split returns its new pane's id).
  const current = useRef(layout);
  // What each pane showed before the component library replaced it, to go back to.
  const beforeLibrary = useRef(new Map<string, Selection>());
  // The latest sidebar state, likewise.
  const sidebarNow = useRef(sidebar);

  // Drafts and ⌘L find the focused pane's composer through chat-context; set before children mount.
  setFocusedPane(layout.focused);

  const apply = useCallback((f: (l: Layout) => Layout) => {
    const next = f(current.current);
    if (next === current.current) return next;
    current.current = next;
    setLayout(next);
    return next;
  }, []);

  useEffect(() => {
    let stale = false;
    api
      .windowLayout()
      .then(({ panes, sidebar }) => {
        if (stale) return;
        if (panes) {
          current.current = panes;
          setLayout(panes);
        }
        sidebarNow.current = sidebar;
        setSidebar(sidebar);
      })
      .catch((e: unknown) => console.error("could not read the window layout", e))
      .finally(() => !stale && setLoaded(true));
    return () => {
      stale = true;
    };
  }, []);

  // Saved a beat after it settles, and before the window goes.
  const unsaved = useRef<Layout | null>(null);
  const save = useCallback(() => {
    const l = unsaved.current;
    unsaved.current = null;
    if (l) api.setLayout(l).catch((e: unknown) => console.error("could not save the layout", e));
  }, []);
  useEffect(() => {
    if (!loaded) return;
    unsaved.current = layout;
    const t = setTimeout(save, SAVE_AFTER_MS);
    return () => clearTimeout(t);
  }, [layout, loaded, save]);
  useLayoutEffect(() => {
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [save]);

  const setPaneContent = useCallback(
    (id: string, content: Selection) =>
      apply((l) => {
        const was = findPane(l, id)?.content ?? null;
        if (content?.kind === "components" && was?.kind !== "components") beforeLibrary.current.set(id, was);
        return setContent(l, id, content);
      }),
    [apply],
  );

  const putSidebar = useCallback((next: SidebarState) => {
    sidebarNow.current = next;
    setSidebar(next);
    api.setSidebar(next).catch((e: unknown) => console.error("could not save the sidebar", e));
  }, []);

  const ops = useMemo(
    () => ({
      /** The focused pane's id, now. */
      focusedId: () => current.current.focused,
      focus: (id: string) => void apply((l) => focusPane(l, id)),
      /** Show `content` in the focused pane (the sidebar, the palette, ⌘N). */
      select: (content: Selection) => void setPaneContent(current.current.focused, content),
      /** Show `content` in pane `id` (the one an action started in), if it's still there; else the focused one. */
      openIn: (id: string, content: Selection) => void setPaneContent(findPane(current.current, id) ? id : current.current.focused, content),
      setPaneContent,
      /** The library goes back to what pane `id` showed before it. */
      closeLibrary: (id: string) => void setPaneContent(id, beforeLibrary.current.get(id) ?? null),
      /** Split the focused pane (`row`: to the right, `column`: downward), the new pane on `content` (the picker by default); returns it, with the focus. */
      split: (dir: Split["dir"], content?: Selection) => {
        let id = current.current.focused;
        apply((l) => {
          const r = splitPane(l, l.focused, dir, content);
          id = r.id;
          return r.layout;
        });
        return id;
      },
      /** Close pane `id` (the focused one by default); false for the last pane, which stays. */
      close: (id?: string) => {
        const before = current.current;
        const target = id ?? before.focused;
        const after = apply((l) => closePane(l, target));
        if (after !== before) beforeLibrary.current.delete(target);
        return after !== before;
      },
      /** Focus the pane next to the focused one; its id, or null when there's none that way. */
      move: (dir: Direction) => {
        const to = neighbour(current.current, current.current.focused, dir);
        if (to) apply((l) => focusPane(l, to));
        return to;
      },
      /** Focus the next pane in reading order (wrapping); its id. */
      next: () => {
        const to = nextPane(current.current, current.current.focused);
        apply((l) => focusPane(l, to));
        return to;
      },
      resize: (splitId: string, ratio: number) => void apply((l) => setRatio(l, splitId, ratio)),
      /** Every pane the same size along its row or column (Ghostty's "equalize splits"). */
      balance: () => void apply(balance),
      mapContents: (f: (c: Selection) => Selection) => void apply((l) => mapContents(l, f)),
      /** Close every pane `keep` rejects (a deleted chat's UI panes); a single home pane when none is left. */
      prune: (keep: (c: Selection) => boolean) => void apply((l) => prune(l, keep)),
      /**
       * Show `content` beside pane `from` (layout.ts `openBeside`: the pane already showing it, else a new
       * split in `dir`); the pane's id, or null when there's no room for another.
       */
      openBeside: (from: string, content: Selection, dir: Split["dir"], options?: Parameters<typeof openBeside>[4]) => {
        let id: string | null = null;
        apply((l) => {
          const r = openBeside(l, from, content, dir, options);
          id = r?.id ?? null;
          return r?.layout ?? l;
        });
        return id;
      },
      toggleSidebar: () => putSidebar({ ...sidebarNow.current, collapsed: !sidebarNow.current.collapsed }),
      /** Its width in CSS pixels, kept within 220–480. */
      setSidebarWidth: (width: number) => {
        const w = Math.round(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, width)));
        if (w !== sidebarNow.current.width) putSidebar({ ...sidebarNow.current, width: w });
      },
    }),
    [apply, setPaneContent, putSidebar],
  );

  const panes = useMemo(() => panesOf(layout.root), [layout.root]);
  return { layout, panes, focused: focusedPane(layout), sidebar, loaded, ...ops };
}
