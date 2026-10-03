/**
 * What Claude was asked in a meeting and handed to the lead: a "Claude, …"
 * the board answered "On it." (`answer.ts`'s `awaiting`). The page shows a
 * steady line naming the work in a few words (`doingLabel`) until the lead's
 * answer arrives. Then the answer's detail is written into the meeting's
 * notes at once, and its first sentence waits for the next pause to be said,
 * so the voice never talks over the meeting (`session.ts`, `sayLead`).
 */
import { meetingLine, noteFor } from '../meeting-claude.ts';
import type { SpokenAnswer } from './answer.ts';

/** The most words the page's line names the work in. */
export const DOING_MAX_WORDS = 4;

/** Asking, not the ask: said before the work it names. */
const ASKING =
  /^(?:(?:can|could|would|will) you|i(?:'d| would) like you to|i want you to|please|go and|go|and|just)\s+/i;

/** The work a request names, in at most `DOING_MAX_WORDS` of its words. */
export function doingLabel(request: string): string {
  let t = request.trim().replace(/[.!?…]+$/, '');
  for (let left = t; ; t = left) {
    left = t.replace(ASKING, '');
    if (left === t || !left) break;
  }
  return t.split(/\s+/).filter(Boolean).slice(0, DOING_MAX_WORDS).join(' ');
}

/** The lead's answer, as the meeting takes it. */
export interface ErrandDone {
  /** For the meeting's notes: the request and the whole answer. */
  note: string;
  /** The page's line now: the latest work still out, or null. */
  label: string | null;
}

export class MeetingErrands {
  /** Work out with the lead, oldest first: queue id to request and label. */
  private readonly out = new Map<string, { request: string; label: string }>();
  /** Answers in, waiting for a pause to be said. */
  private held: SpokenAnswer[] = [];

  /** The lead took `request` as `queueId`; the page's line now. */
  started(queueId: string, request: string): string {
    const label = doingLabel(request);
    this.out.set(queueId, { request, label });
    return label;
  }

  /** The lead answered `queueId`; null when the meeting did not ask it. */
  answered(queueId: string, a: SpokenAnswer, asker: string | null): ErrandDone | null {
    const asked = this.out.get(queueId);
    if (!asked) return null;
    this.out.delete(queueId);
    this.held.push({ ...meetingLine(a), detail: [], asking: false });
    return {
      note: noteFor(asked.request, a, asker),
      label: [...this.out.values()].pop()?.label ?? null,
    };
  }

  get waiting(): boolean {
    return this.held.length > 0;
  }

  /** Every held answer, for the pause about to be said. */
  take(): SpokenAnswer[] {
    const held = this.held;
    this.held = [];
    return held;
  }

  /** The pause they were taken for was never said: they wait for the next. */
  restore(held: SpokenAnswer[]): void {
    this.held = [...held, ...this.held];
  }
}

/** A pause's own answer, with the held answers said first. */
export function withHeld(held: readonly SpokenAnswer[], own: SpokenAnswer): SpokenAnswer {
  if (held.length === 0) return own;
  return {
    ...own,
    spoken: [...held.map((h) => h.spoken), own.spoken].filter(Boolean).join(' '),
    points: [...held.flatMap((h) => h.points), ...own.points],
    route: own.spoken ? own.route : (held[0]?.route ?? own.route),
  };
}
