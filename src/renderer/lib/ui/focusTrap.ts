// Tab and Shift+Tab stay inside a modal panel (dialogs, the palette, the pickers), so the keyboard
// never wanders to the window behind it while it's open.
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** A keydown handler for the panel. */
export function trapTab(e: KeyboardEvent, panel: HTMLElement | null): void {
  if (e.key !== 'Tab' || e.defaultPrevented || !panel) return;
  const els = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null,
  );
  if (!els.length) return void e.preventDefault();
  const first = els[0];
  const last = els[els.length - 1];
  const active = document.activeElement;
  const inside = !!active && panel.contains(active);
  if (e.shiftKey && (!inside || active === first || active === panel))
    (e.preventDefault(), last.focus());
  else if (!e.shiftKey && (!inside || active === last)) (e.preventDefault(), first.focus());
}
