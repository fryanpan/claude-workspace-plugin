/**
 * When a person talking through a plan has paused, as opposed to stopped for
 * breath in the middle of a sentence. The planning voice asks its questions
 * only at a pause (`interview.ts`), so this is what keeps it from cutting in.
 *
 * One rule, the owner's (2026-10-02, after his first planning meeting):
 *
 *  - after a phrase that is not yet a sentence (it stops on a comma, a dash,
 *    an ellipsis, or a word a sentence cannot end on: "and", "the",
 *    "because"), wait `UNFINISHED_PAUSE_MS` of silence;
 *  - otherwise the pause is whichever comes first: the listener's own end of
 *    utterance (a final turn), or `FINISHED_PAUSE_MS` of silence.
 *
 * Silence is time with no new words, final or not; any new words start it
 * again. Both numbers are a `SpokenPause` the page may send with each
 * `start`, so the owner can try values during a meeting; the defaults are
 * his. Turns in, one call out, and the timers through a seam so a test
 * drives a recorded turn trace on a fake clock.
 */

import { SPOKEN_PAUSE_DEFAULT, type SpokenPause } from '@claude-workspaces/core/spoken-reply';

/** Silence after a finished-sounding phrase that counts as a pause, when the
 *  listener has not called the end of the utterance first. */
export const FINISHED_PAUSE_MS = SPOKEN_PAUSE_DEFAULT.finishedMs;
/** Silence after a phrase that stops mid-sentence. */
export const UNFINISHED_PAUSE_MS = SPOKEN_PAUSE_DEFAULT.unfinishedMs;

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
  /** The pause was called on these words; their final turn calls none. */
  private called = false;

  constructor(
    private readonly onPause: () => void,
    private readonly timers: GateTimers = REAL_TIMERS,
    private timing: SpokenPause = SPOKEN_PAUSE_DEFAULT,
  ) {}

  /** What the listener heard: the turn so far, and whether it is final. */
  heard(text: string, final: boolean): void {
    const t = text.trim();
    const news = t !== '' && t !== this.last;
    this.last = t;
    if (news) this.called = false;
    if (!t || this.called) return;
    const unfinished = midSentence(t);
    if (final && !unfinished) {
      this.cancel();
      this.call();
      return;
    }
    // Silence runs from the last new words, so a final repeating them, or a
    // repeated partial, leaves the window where it is.
    if (!news && this.timer !== null) return;
    this.cancel();
    this.timer = this.timers.set(
      () => {
        this.timer = null;
        this.call();
      },
      unfinished ? this.timing.unfinishedMs : this.timing.finishedMs,
    );
  }

  /** A new setting, for the next wait; a window already running keeps its own. */
  retime(timing: SpokenPause): void {
    this.timing = timing;
  }

  private call(): void {
    this.called = true;
    this.onPause();
  }

  get armed(): boolean {
    return this.timer !== null;
  }

  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
