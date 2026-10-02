/**
 * When a person talking through a plan has paused, as opposed to stopped for
 * breath in the middle of a sentence. The planning voice asks its questions
 * only at a pause (`interview.ts`), so this is what keeps it from cutting in.
 *
 * The listener's end of speech is the first half: a final turn means it heard
 * the speaker stop. On its own that is not enough. Soniox calls an endpoint
 * after a long breath too, and "the rollout starts at Harborlight and" is a
 * final turn that is plainly not finished. So a final turn arms a confirm
 * window, and the pause is called only when the window runs out with nothing
 * new heard:
 *
 *  - `PAUSE_CONFIRM_MS` after a turn that reads finished;
 *  - `DANGLING_CONFIRM_MS` after one that ends mid-sentence: on a comma, a
 *    dash or an ellipsis, or on a word a sentence cannot end on ("and",
 *    "the", "because").
 *
 * Any new words heard inside the window cancel it, and the next final turn
 * arms it again. Turns in, one call out, and the timers through a seam so a
 * test drives a recorded turn trace on a fake clock.
 */

/** Quiet after a finished-sounding turn before it counts as a pause. */
export const PAUSE_CONFIRM_MS = 1200;
/** Quiet after a turn that stops mid-sentence. */
export const DANGLING_CONFIRM_MS = 3500;

export interface GateTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const REAL_TIMERS: GateTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Words an English sentence does not end on. */
const DANGLING =
  /\b(?:and|or|but|so|because|if|then|than|that|which|who|when|while|with|without|of|to|for|from|in|on|at|by|into|the|a|an|my|our|their|is|are|was|were|will|would|should|could|can|um+|uh+|er+)$/i;

/** Whether `text` stops in the middle of a sentence. */
export function midSentence(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/(?:,|;|:|-|–|—|\.\.\.|…)$/.test(t)) return true;
  return DANGLING.test(t.replace(/[.!?]+$/, '').trim()) && !/[!?]$/.test(t);
}

export class PauseGate {
  private timer: unknown = null;
  /** Words heard so far, so a repeated partial is not news. */
  private last = '';

  constructor(
    private readonly onPause: () => void,
    private readonly timers: GateTimers = REAL_TIMERS,
  ) {}

  /** What the listener heard: the turn so far, and whether it is final. */
  heard(text: string, final: boolean): void {
    const t = text.trim();
    if (!final) {
      if (t && t !== this.last) this.cancel();
      this.last = t;
      return;
    }
    this.cancel();
    this.last = t;
    const ms = midSentence(t) ? DANGLING_CONFIRM_MS : PAUSE_CONFIRM_MS;
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.onPause();
    }, ms);
  }

  get armed(): boolean {
    return this.timer !== null;
  }

  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
