/**
 * The interview's slots: one per gap in the plan, in the order they are
 * asked. A slot is asked, then settled by exactly one transition — placed
 * (its answer was written), skipped, deferred (asked again after the
 * others), gone (its heading left the doc) or ended (the interview stopped
 * on it). Nothing here reads or writes the doc; `interview.ts` does that and
 * reports the transition.
 *
 * Kept apart from `SpokenAnswerer`'s pending goal choice on purpose: that is
 * one question with one answer, and this is a queue.
 */
import type { PlanGap } from './interview-gaps.ts';

export type SlotTransition = 'placed' | 'skipped' | 'deferred' | 'gone' | 'ended';

/** What a silence after the question gets: once, the offer to skip it;
 *  after that, the question again. */
export type SilenceReply = 'offer-skip' | 'repeat';

export class InterviewSlots {
  readonly total: number;
  private readonly queue: PlanGap[];
  private slot: PlanGap | null;
  private placedCount = 0;
  private skippedCount = 0;
  private offeredSkip = false;

  constructor(gaps: readonly PlanGap[]) {
    this.queue = [...gaps];
    this.total = gaps.length;
    this.slot = this.queue.shift() ?? null;
  }

  /** The slot being asked, or null once the interview is over. */
  get current(): PlanGap | null {
    return this.slot;
  }

  get placed(): number {
    return this.placedCount;
  }

  get skipped(): number {
    return this.skippedCount;
  }

  /** The slots never reached, in the order they would have been asked. */
  get unasked(): readonly PlanGap[] {
    return this.queue;
  }

  /** The current slot's heading has a new block id (a reparse re-minted it). */
  rebind(headingId: string): void {
    if (this.slot) this.slot = { ...this.slot, headingId };
  }

  /** Nothing was said after the question. */
  silence(): SilenceReply {
    if (this.offeredSkip) return 'repeat';
    this.offeredSkip = true;
    return 'offer-skip';
  }

  /**
   * Settle the current slot and move to the next. `again` is true when the
   * next slot is the one just deferred — it was the only one left.
   */
  settle(how: SlotTransition): { next: PlanGap | null; again: boolean } {
    const was = this.slot;
    if (!was) return { next: null, again: false };
    if (how === 'ended') {
      this.slot = null;
      return { next: null, again: false };
    }
    if (how === 'placed') this.placedCount++;
    if (how === 'skipped') this.skippedCount++;
    if (how === 'deferred') this.queue.push(was);
    this.slot = this.queue.shift() ?? null;
    this.offeredSkip = false;
    return { next: this.slot, again: this.slot === was };
  }
}

/** How long a meeting is heard before the voice asks anything unprompted:
 *  its opening is greetings and small talk, and a plan that is still nearly
 *  empty always has a question to cut in with (Bryan, 3 Oct: it cut in too
 *  soon early on). "Any questions?" is answered at once all the same. */
export const MEETING_WARMUP_MS = 60_000;

/** Whether a meeting on a doc is still inside its opening, timed from the
 *  first pause it was heard at. */
export class MeetingWarmup {
  private readonly from = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly ms = MEETING_WARMUP_MS,
  ) {}

  warming(docId: string): boolean {
    const at = this.now();
    const from = this.from.get(docId) ?? at;
    this.from.set(docId, from);
    return at - from < this.ms;
  }
}
