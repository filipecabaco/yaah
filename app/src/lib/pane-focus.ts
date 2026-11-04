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

/** A pending permission card in the transcript (entries.tsx). */
const PENDING_PERMISSION = '[role="group"][aria-label="Permission requested"]';

/**
 * Where the keyboard goes once a permission request is answered (KB-1): its buttons go away, and
 * focus would fall to the page. Call it as the answer is sent, while `card` is on the page; call
 * what it returns once the answer is in. Focus goes to the next request still waiting in the same
 * pane (its first answer button), else that pane's message box; and only when the keyboard is on
 * the card or nowhere, so a slow answer doesn't pull focus from where the user went meanwhile.
 */
export function focusAfterPermission(card: HTMLElement | null): () => void {
  const scope = card?.closest<HTMLElement>("[data-pane-id]") ?? card?.closest<HTMLElement>('[role="log"]')?.parentElement ?? document.body;
  return () => {
    const active = document.activeElement;
    if (active && active !== document.body && !card?.contains(active)) return;
    const next = [...scope.querySelectorAll<HTMLElement>(PENDING_PERMISSION)]
      .filter((c) => c !== card)
      .map((c) => c.querySelector<HTMLElement>("button:not([disabled])"))
      .find((b) => b != null);
    const target =
      next ?? scope.querySelector<HTMLElement>("textarea[data-composer]") ?? document.querySelector<HTMLElement>("textarea[data-composer]");
    target?.focus({ preventScroll: !next });
  };
}

/**
 * The skip link (App.tsx): past the sidebar to the focused pane's message box or first field,
 * else the pane itself, else the main area (SR-5).
 */
export function focusMain(paneId: string) {
  const pane = document.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`);
  const target = pane?.querySelector<HTMLElement>("textarea[data-composer], [data-pane-autofocus]") ?? pane ?? document.getElementById("main");
  target?.focus();
}
