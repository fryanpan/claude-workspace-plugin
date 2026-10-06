/**
 * Who may take a live meeting over from the socket holding it.
 *
 * A phone that goes into the background can leave its audio socket open for
 * minutes with nothing arriving on it, and the doc stays held by that socket
 * until the transport times it out. A Record press, or a resume, from the
 * SAME person on a new socket now closes the old one and resumes the meeting
 * (`MeetingRelay.start`). Anyone else is refused as before.
 *
 * "The same person" is the identity each socket's upgrade PROVED — the Access
 * claim, the signed session cookie or the widget token, stamped as
 * `data.author` by `routes/upgrade-stream.ts`. Never the start frame's
 * `participant`, which the page writes. A socket that proved nobody can take
 * nothing over and can lose nothing to a takeover, because with no proof on
 * either side there is no way to tell one person from two.
 */
import type { User } from '@claude-workspaces/core';

/** The close code the old socket gets: an application code, "conflict". */
export const TAKEOVER_CLOSE_CODE = 4409;

/** What the old socket's page is told before it is closed. */
export const TAKEN_OVER_MESSAGE = 'This recording moved to another window.';

/** Whether two sockets' proven identities name the same person. */
export function samePerson(
  holder: User | null | undefined,
  claimant: User | null | undefined,
): boolean {
  if (!holder || !claimant) return false;
  if (holder.kind !== 'known' || claimant.kind !== 'known') return false;
  return holder.id !== '' && holder.id === claimant.id;
}
