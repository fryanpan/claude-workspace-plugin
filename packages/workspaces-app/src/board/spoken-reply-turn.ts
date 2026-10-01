/**
 * One question's clock on the page, and the `timing` report built from it.
 *
 * THE DELAY. From the end of the question — the release for a held one, the
 * last frame loud enough to be speech for a tapped one — to the moment the
 * first audible sample of the reply plays. The report waits until the reply
 * has finished playing (or was stopped), because it also carries each note's
 * lead, and the last note only lands as the last point starts.
 */
import type { SpokenClientMessage, SpokenMode } from '@claude-workspaces/core/spoken-reply';

export type SpokenTiming = Extract<SpokenClientMessage, { type: 'timing' }>;

export interface Turn {
  mode: SpokenMode | null;
  /** From a tapped choice, not from the microphone: nothing to time. */
  fromChoice: boolean;
  releasedAt: number | null;
  lastVoiceAt: number | null;
  turnEndAt: number | null;
  replyAt: number | null;
  asking: boolean;
  timed: boolean;
  /** Measured at the first word, sent once the reply is over. */
  pending: SpokenTiming | null;
}

export function newTurn(fromChoice = false): Turn {
  return {
    mode: null,
    fromChoice,
    releasedAt: null,
    lastVoiceAt: null,
    turnEndAt: null,
    replyAt: null,
    asking: false,
    timed: false,
    pending: null,
  };
}

/** The report for a first word heard at `at`, or null when there is nothing
 *  to time: a tapped choice, or a question whose end was never seen. */
export function timingAt(turn: Turn, at: number): SpokenTiming | null {
  if (turn.timed || turn.fromChoice) return null;
  const end =
    turn.mode === 'hold' || turn.lastVoiceAt === null ? turn.releasedAt : turn.lastVoiceAt;
  const questionEnd = end ?? turn.turnEndAt;
  if (questionEnd === null) return null;
  return {
    type: 'timing',
    delayMs: Math.max(0, at - questionEnd),
    ...(turn.turnEndAt !== null ? { endpointMs: Math.max(0, turn.turnEndAt - questionEnd) } : {}),
    ...(turn.turnEndAt !== null && turn.replyAt !== null
      ? { replyMs: Math.max(0, turn.replyAt - turn.turnEndAt) }
      : {}),
    ...(turn.replyAt !== null ? { audioMs: Math.max(0, at - turn.replyAt) } : {}),
  };
}
