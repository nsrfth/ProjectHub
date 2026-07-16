import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Shared dialog behaviour for Modal / SlideOver (v2.5.57):
 *  - moves focus to the first focusable element on open, restores it on close
 *  - traps Tab / Shift+Tab inside the panel (WCAG 2.1.2 "no keyboard trap"
 *    outside, full trap inside while open)
 *  - closes on Escape
 *  - locks body scroll while open so the page doesn't scroll behind the panel
 */
export function useDialog(
  panelRef: RefObject<HTMLElement>,
  onClose: () => void,
): void {
  useEffect(() => {
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    panel?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;

      const nodes = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => !el.hasAttribute('disabled'));
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;

      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose, panelRef]);
}
