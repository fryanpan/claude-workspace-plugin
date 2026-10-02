/**
 * The spoken reply's press and release: the board mic's button, and a held
 * Space on the page itself — the same rules as the plain mic's
 * (`voice-capture.ts`): never while typing, never on a focused control, armed
 * only after `SPACE_HOLD_ARM_MS` so a tap still pages down, and the page kept
 * still under a hold. A hold from Space is always a held question; the
 * button's press says nothing yet, because a quick tap is a tapped one.
 */
import { eventPath, typingInPath } from '../keyboard-target.ts';
import { SPACE_HOLD_ARM_MS, defaultSpaceScroll, spaceHoldTargetsPage } from '../voice-capture.ts';

export interface SpokenHoldOpts {
  document: Document;
  button: HTMLElement;
  onPress(fromSpace: boolean): void;
  onRelease(): void;
  /** Escape: true when it was used (the panel closed). */
  onEscape(): boolean;
}

export function wireSpokenHold(opts: SpokenHoldOpts): { destroy(): void } {
  const { document: doc, button: btn } = opts;
  const onPointerDown = (ev: Event): void => {
    ev.preventDefault();
    opts.onPress(false);
  };
  const onPointerUp = (): void => opts.onRelease();

  let armTimer: ReturnType<typeof setTimeout> | null = null;
  let armedTap: { target: EventTarget | null; direction: 1 | -1 } | null = null;
  let spaceHolding = false;
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      opts.onEscape();
      return;
    }
    if (ev.code !== 'Space') return;
    if (ev.repeat) {
      if (spaceHolding || armTimer) ev.preventDefault();
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const path = eventPath(ev);
    if (typingInPath(path) || !spaceHoldTargetsPage(path)) return;
    ev.preventDefault();
    if (armTimer || spaceHolding) return;
    armedTap = { target: path[0] ?? null, direction: ev.shiftKey ? -1 : 1 };
    armTimer = setTimeout(() => {
      armTimer = null;
      armedTap = null;
      spaceHolding = true;
      opts.onPress(true);
    }, SPACE_HOLD_ARM_MS);
  };
  const onKeyUp = (ev: KeyboardEvent): void => {
    if (ev.code !== 'Space') return;
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
      const tap = armedTap;
      armedTap = null;
      if (tap) defaultSpaceScroll(tap.target, tap.direction);
      return;
    }
    if (!spaceHolding) return;
    spaceHolding = false;
    opts.onRelease();
  };
  const onBlur = (): void => {
    if (armTimer) clearTimeout(armTimer);
    armTimer = null;
    armedTap = null;
    spaceHolding = false;
    opts.onRelease();
  };

  btn.addEventListener('pointerdown', onPointerDown);
  btn.addEventListener('pointerup', onPointerUp);
  btn.addEventListener('pointercancel', onPointerUp);
  doc.addEventListener('keydown', onKeyDown);
  doc.addEventListener('keyup', onKeyUp);
  doc.defaultView?.addEventListener('blur', onBlur);
  btn.title = 'Hold to talk (or hold Space)';

  return {
    destroy() {
      btn.removeEventListener('pointerdown', onPointerDown);
      btn.removeEventListener('pointerup', onPointerUp);
      btn.removeEventListener('pointercancel', onPointerUp);
      doc.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('keyup', onKeyUp);
      doc.defaultView?.removeEventListener('blur', onBlur);
      if (armTimer) clearTimeout(armTimer);
    },
  };
}
