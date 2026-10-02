/**
 * The spoken reply's taps: the board mic's button, and Space on the page
 * itself. Each is a toggle (Bryan, 2 Oct: holding is wrong) — one tap starts
 * a question, the next ends it by hand, and nothing waits on a release.
 * Space follows the plain mic's rules for where it counts (`voice-capture.ts`):
 * never while typing, never on a focused control. A key held down repeats
 * nothing.
 */
import { eventPath, typingInPath } from '../keyboard-target.ts';
import { spaceHoldTargetsPage } from '../voice-capture.ts';

export interface SpokenTapOpts {
  document: Document;
  button: HTMLElement;
  onTap(): void;
  /** Escape: true when it was used (the panel closed). */
  onEscape(): boolean;
}

export const SPOKEN_TAP_TITLE = 'Tap to talk (or tap Space)';

export function wireSpokenTap(opts: SpokenTapOpts): { destroy(): void } {
  const { document: doc, button: btn } = opts;
  const onPointerDown = (ev: Event): void => {
    ev.preventDefault();
    opts.onTap();
  };
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      opts.onEscape();
      return;
    }
    if (ev.code !== 'Space') return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const path = eventPath(ev);
    if (typingInPath(path) || !spaceHoldTargetsPage(path)) return;
    ev.preventDefault();
    if (ev.repeat) return;
    opts.onTap();
  };

  btn.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener('keydown', onKeyDown);
  btn.title = SPOKEN_TAP_TITLE;
  btn.setAttribute('aria-label', 'Tap to talk');

  return {
    destroy() {
      btn.removeEventListener('pointerdown', onPointerDown);
      doc.removeEventListener('keydown', onKeyDown);
    },
  };
}
