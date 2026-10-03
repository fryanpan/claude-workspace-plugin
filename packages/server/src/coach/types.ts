/**
 * The coach: Bryan's learning goals, what it sees him doing, and the moments
 * it raises when what he is doing matches a goal's "act differently when".
 *
 * The design is the "Version 1 design" section of the coach doc on the
 * Workspaces board, in three workflows: A, set the goals (one doc, filled in
 * by the voice interview); B, watch (owner activity rows plus a where-I-am
 * signal from board and doc pages); C, speak up (a card on the page he is
 * on). Everything here is the owner's alone: nothing is on a share, a member
 * allowlist or an agent's stream.
 *
 * Nothing is ever deleted. A moment leaves the page by being answered or
 * expiring, never by being removed.
 */

/** How often the coach may speak: the gap after one moment before the next
 *  may be raised. "Not now" doubles it for the rest of that local day. */
export type CoachSpacing = 'more' | 'normal' | 'less';
export const COACH_SPACINGS: readonly CoachSpacing[] = ['less', 'normal', 'more'];
export const SPACING_MS: Record<CoachSpacing, number> = {
  more: 30 * 60_000,
  normal: 60 * 60_000,
  less: 3 * 60 * 60_000,
};

/** Where the learning-goals doc is, once it exists. */
export interface CoachGoalsDoc {
  workspaceId: string;
  docId: string;
  createdAt: number;
}

/**
 * `open` shows on the page. `thanks`, `not-now` and `not-this` are his three
 * answers: useful, right goal at the wrong time, and a wrong call. `expired`
 * is one he left: it closes after `MOMENT_TTL_MS` and counts as unanswered.
 */
export type MomentState = 'open' | 'thanks' | 'not-now' | 'not-this' | 'expired';
export type MomentAnswer = 'thanks' | 'not-now' | 'not-this';
export const MOMENT_ANSWERS: readonly MomentAnswer[] = ['thanks', 'not-now', 'not-this'];
export const MOMENT_TTL_MS = 10 * 60_000;

export interface CoachMoment {
  /** `cm-` + 12 characters. */
  id: string;
  at: number;
  /** The local day it was raised on, `YYYY-MM-DD`. */
  day: string;
  /** 0-based, into the goals as the doc held them then. */
  goalIndex: number;
  /** The goal's title then, so a later edit cannot change what it was about. */
  goal: string;
  /** The words of that goal's "act differently when" the model matched. */
  matched: string;
  /** What the coach saw, in its words. */
  observed: string;
  /** The one line the card shows, ending in a question. */
  line: string;
  state: MomentState;
  answeredAt?: number;
}

/** What one judgement did. Outcomes and counts only, never his activity. */
export type JudgementOutcome =
  | 'moment'
  | 'quiet'
  | 'unusable-reply'
  /** The session was asked and did not answer in time. */
  | 'no-answer'
  /** No session to ask: the Coach board has no lead attached. */
  | 'no-session';

export interface CoachJudgement {
  at: number;
  outcome: JudgementOutcome;
  /** Why it was asked: a trigger, or a request on this machine. */
  cause: 'trigger' | 'asked';
}

export interface CoachState {
  /** His time zone, from the browser he last used. */
  timeZone: string;
  /** The learning-goals doc. The coach's name and the goals are read from
   *  it each time, never copied here. */
  goalsDoc?: CoachGoalsDoc;
  spacing: CoachSpacing;
  /** The last time he changed the goals doc (his own edit). */
  goalsChangedAt?: number;
  /** The last time he said the goals need no update. */
  reviewDeclinedAt?: number;
  moments: CoachMoment[];
  /** Newest last, capped at `MAX_JUDGEMENTS`. */
  judgements: CoachJudgement[];
}

export const MAX_JUDGEMENTS = 500;
/** A ceiling under the spacing rule, whatever the setting. */
export const MAX_MOMENTS_PER_DAY = 8;
/** The weekly offer to review the goals. */
export const REVIEW_AFTER_MS = 7 * 24 * 60 * 60_000;
