import { useEffect, useRef } from "react";

/**
 * Track which modal is on top so ESC only closes the most recently opened one
 * (instead of every open modal at once). Module-scoped because modal lifetime
 * is independent of any single React tree branch.
 */
const MODAL_STACK: symbol[] = [];

/**
 * Wire up the dismissal contract that every modal/panel in this app should
 * honor:
 *
 * - ESC closes the topmost modal (and only the topmost).
 * - When the modal unmounts focus returns to the element that had focus before
 *   it opened, so screen-reader / keyboard users don't get teleported back to
 *   the document body.
 * - Skipped entirely when `enabled` is false so disabled / busy modals can
 *   suppress the dismissal without conditionally calling the hook.
 */
export function useModalDismiss(enabled: boolean, onClose: () => void): void {
  // Closer ref captured up front so the effect doesn't re-attach on every
  // re-render that produces a new closure for onClose.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    const id = Symbol("modal");
    MODAL_STACK.push(id);

    // Remember the element to return focus to. document.activeElement might
    // be inside the just-mounted modal if focus was already moved (e.g. a
    // ref autofocus); guard against that by reading it synchronously before
    // the modal becomes interactive.
    const previousFocus = document.activeElement as HTMLElement | null;

    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (MODAL_STACK[MODAL_STACK.length - 1] !== id) return;
      event.stopPropagation();
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", handler);

    return () => {
      document.removeEventListener("keydown", handler);
      const idx = MODAL_STACK.indexOf(id);
      if (idx >= 0) MODAL_STACK.splice(idx, 1);
      // Only restore if focus is still inside the (now unmounting) modal —
      // otherwise the user has already moved focus elsewhere intentionally.
      if (previousFocus && document.body.contains(previousFocus)) {
        try {
          previousFocus.focus({ preventScroll: true });
        } catch {
          // Some elements throw if they're not focusable anymore (e.g. a
          // toolbar item that was removed); silently ignore.
        }
      }
    };
  }, [enabled]);
}
