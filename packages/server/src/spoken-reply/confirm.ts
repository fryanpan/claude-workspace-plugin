/**
 * Propose, read back, commit: the step every spoken decision goes through,
 * whatever it decides. The review queue uses it today; a doc follow-up that
 * records something by voice uses the same one.
 *
 * NOTHING IS COMMITTED UNTIL A YES. `propose` returns the read-back
 * ("Recording: Approve. OK?"); `judge` reads the next thing said against it.
 * Only a yes lets the caller `commit`, which mints the id the page reports
 * back on and opens an undo window of exactly one utterance: the caller
 * passes every utterance through `takeBack` first, and a "no", "wait" or
 * "undo that" there returns the commit to take back.
 *
 * The caller owns what a subject is and what a commit writes; this module
 * owns only the words of the read-back and the bookkeeping of what was sent.
 */
import { isYes, refusal, stops, undoes } from './review-words.ts';

export interface Proposal {
  text: string;
  optionId?: string;
}

/** What was said to a read-back. `other` names a different proposal
 *  ("no, the second one"); `no` is a refusal with nothing after it. */
export type Verdict =
  | { kind: 'yes'; proposal: Proposal }
  | { kind: 'stop' }
  | { kind: 'other'; proposal: Proposal }
  | { kind: 'no' }
  | { kind: 'unclear'; say: string[] };

export type SentAction = 'record' | 'undo';

/** The choices a read-back offers on the screen. */
export const READ_BACK_CHOICES: readonly string[] = ['Yes', 'No'];

function sentence(s: string): string {
  const t = s.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

export class Confirm<S> {
  private pending: Proposal | null = null;
  private window: { subject: S; id: string } | null = null;
  private sent = new Map<string, { subject: S; action: SentAction }>();
  private seq = 0;

  /** A read-back is waiting on a yes or no. */
  get confirming(): boolean {
    return this.pending !== null;
  }

  /** The last commit can still be taken back by the next utterance. */
  get undoable(): boolean {
    return this.window !== null;
  }

  /** Read `proposal` back; the next `judge` answers it. */
  propose(proposal: Proposal): string[] {
    this.pending = proposal;
    return [`Recording: ${sentence(proposal.text)}`, 'OK?'];
  }

  /**
   * The verdict on what was said to the pending read-back. `pick` names the
   * proposal the words choose, if any. Anything but `unclear` and `other`
   * leaves no read-back pending; `other` leaves the caller to propose it.
   */
  judge(heard: string, pick: (said: string) => Proposal | null): Verdict {
    const proposal = this.pending;
    if (!proposal) return { kind: 'no' };
    if (isYes(heard)) {
      this.pending = null;
      return { kind: 'yes', proposal };
    }
    if (stops(heard)) {
      this.pending = null;
      return { kind: 'stop' };
    }
    const rest = refusal(heard);
    const other = pick(rest ?? heard);
    if (other) {
      this.pending = null;
      return { kind: 'other', proposal: other };
    }
    if (rest !== null) {
      this.pending = null;
      return { kind: 'no' };
    }
    return { kind: 'unclear', say: [`Say yes to record ${proposal.text}, or no.`] };
  }

  /** Record a yes: the id the page's report names, and the undo window open. */
  commit(subject: S): string {
    const id = this.mint(subject, 'record');
    this.window = { subject, id };
    return id;
  }

  /**
   * Pass every utterance through here first. It closes the undo window
   * either way, and returns the commit to take back when the words undo it.
   */
  takeBack(heard: string): { id: string; subject: S } | null {
    const recorded = this.window;
    this.window = null;
    if (!recorded || !undoes(heard)) return null;
    return { id: this.mint(recorded.subject, 'undo'), subject: recorded.subject };
  }

  /** The page's report on a sent id: what it was, or null when the write
   *  went through or the id is not one of ours. A failed commit cannot be
   *  undone, so its window closes. */
  settled(id: string, ok: boolean): { subject: S; action: SentAction } | null {
    const sent = this.sent.get(id);
    this.sent.delete(id);
    if (!sent || ok) return null;
    if (this.window?.id === id) this.window = null;
    return sent;
  }

  /** Drop any pending read-back and undo window — a fresh start. */
  reset(): void {
    this.pending = null;
    this.window = null;
  }

  private mint(subject: S, action: SentAction): string {
    const id = `d${++this.seq}`;
    this.sent.set(id, { subject, action });
    return id;
  }
}
