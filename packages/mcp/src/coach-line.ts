/**
 * How a `coach.candidate` frame reads to the coach session that receives it.
 *
 * The server sends one of these to the Coach board's lead when what the owner
 * is doing might be a moment one of their goals names. The frame carries the
 * judging rules (`system`) and what they are doing (`prompt`), so the line is
 * the whole question: the session needs nothing else to answer, and its
 * answer goes back through `coach_reply` before the candidate lapses.
 *
 * Kept out of channel-messages.ts for the reason voice-line.ts is: the
 * wording is a decision, and this is where a test can read it.
 */

export interface CoachCandidatePayload {
  candidateId?: string;
  system?: string;
  prompt?: string;
}

/** The line, or null when the frame names no candidate to answer. */
export function coachCandidateLine(p: CoachCandidatePayload): string | null {
  if (typeof p.candidateId !== 'string' || p.candidateId === '') return null;
  return [
    `[coach.candidate] Judge this as the coach (skill claude-workspaces:coaching). Answer within 3 minutes with coach_reply(candidateId="${p.candidateId}", verdict). Quiet unless it plainly matches.`,
    '',
    'How to judge:',
    p.system ?? '(not sent)',
    '',
    'What they are doing:',
    p.prompt ?? '(not sent)',
  ].join('\n');
}
