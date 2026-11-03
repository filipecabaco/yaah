// Moving the keyboard between split panes (components/panes.tsx).

/**
 * Move the keyboard into pane `id` once it's on screen: its message box, its own
 * first field (`data-pane-autofocus`), or the pane itself.
 */
export function focusPaneDom(id: string) {
  setTimeout(() => {
    const el = document.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
    if (!el || el.contains(document.activeElement)) return;
    (el.querySelector<HTMLElement>("textarea[data-composer], [data-pane-autofocus]") ?? el).focus({ preventScroll: true });
  });
}
