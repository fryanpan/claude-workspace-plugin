/**
 * The goal coach: Bryan's three goals for the week, and the nudges a check
 * raises when his day drifts from them.
 *
 * Version 1 is for the owner alone (the design is the "Version 1 design"
 * section of the coach doc on the Workspaces board). Everything here belongs
 * to him, so nothing is on a board, a share or an agent's stream: the goals
 * and nudges reach a page only through the front page of his own signed-in
 * session.
 *
 * Nothing is ever deleted. A replaced goal list stays in `lists`, and a
 * nudge leaves the page by being answered or expired, never by being
 * removed.
 */

/** At most this many goals in a week. */
export const MAX_GOALS = 3;
/** A goal is one line. */
export const MAX_GOAL_CHARS = 140;

/** One week's goals as Bryan wrote them. `week` is that week's Monday,
 *  `YYYY-MM-DD`, in his time zone. */
export interface CoachGoalList {
  week: string;
  goals: string[];
  setAt: number;
}

/**
 * `open` shows on the page. `back-to-it` and `plans-changed` are Bryan's two
 * answers; `expired` is a nudge the day ended on with no answer.
 */
export type NudgeState = 'open' | 'back-to-it' | 'plans-changed' | 'expired';
export type NudgeAnswer = 'back-to-it' | 'plans-changed';
export const NUDGE_ANSWERS: readonly NudgeAnswer[] = ['back-to-it', 'plans-changed'];

export interface CoachNudge {
  /** `cn-` + 12 characters. */
  id: string;
  at: number;
  /** The local day it was raised on, `YYYY-MM-DD`. It expires after it. */
  day: string;
  /** 0-based, into the week's list at the time. */
  goalIndex: number;
  /** The goal's words when the nudge was raised, so a later edit of the
   *  list cannot change what an old nudge was about. */
  goal: string;
  /** What the time went to instead, in the coach's words. */
  drift: string;
  /** The one question the page shows. */
  question: string;
  state: NudgeState;
  answeredAt?: number;
}

/** What one check did, kept so "is it running?" has an answer. Counts and
 *  outcomes only, never a word of the activity it read. */
export type PassOutcome =
  | 'nudged'
  | 'on-track'
  | 'no-goals'
  | 'no-new-activity'
  | 'nudge-open'
  | 'daily-cap'
  | 'no-model'
  | 'unusable-reply';

export interface CoachPassRecord {
  at: number;
  outcome: PassOutcome;
  /** How many activity lines the check read. */
  lines: number;
}

export interface CoachState {
  /** Bryan's time zone, from the browser he last saved goals in. */
  timeZone: string;
  /** Every list ever saved, oldest first. The week's list is the newest
   *  one naming that week. */
  lists: CoachGoalList[];
  nudges: CoachNudge[];
  /** Newest last, capped at `MAX_PASS_RECORDS`. */
  passes: CoachPassRecord[];
}

export const MAX_PASS_RECORDS = 200;
/** At most this many nudges on one local day. */
export const MAX_NUDGES_PER_DAY = 2;
