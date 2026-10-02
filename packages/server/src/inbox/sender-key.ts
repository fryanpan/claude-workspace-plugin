/**
 * The key a row matches its sender by, derived here from the sender's own
 * stable id so the reader never has to hash anything.
 *
 * The id is an address or a number from outside the trust zone, so it is
 * used for one thing: the hash. It is never stored, logged, returned, or
 * named in a refusal. Only the key leaves this module.
 */
import { createHash } from 'node:crypto';
import type { InboxSource } from './types.ts';

const MAX_SENDER_ID = 320;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * One spelling per sender, per source:
 *  - gmail: an email address; trimmed and lowercased.
 *  - slack: a Slack user id (`U0123ABCD`); trimmed and uppercased, the case
 *    Slack itself issues them in.
 *  - messages: a phone number or, for an iMessage handle, an email address.
 *    An address is lowercased as for gmail; a number keeps its digits and a
 *    leading `+`, with spaces, dashes, dots and brackets dropped. No country
 *    code is guessed, so `+1 415…` and `415…` are two keys.
 */
function normalise(source: InboxSource, id: string): string {
  const t = id.trim();
  switch (source) {
    case 'gmail':
      return t.toLowerCase();
    case 'slack':
      return t.toUpperCase();
    case 'messages':
      return t.includes('@') ? t.toLowerCase() : t.replace(/[\s().-]/g, '');
  }
}

/** The key for `senderId`, or null when it is not a plain id: empty, longer
 *  than 320 characters, or carrying a control character. */
export function senderKeyFor(source: InboxSource, senderId: unknown): string | null {
  if (typeof senderId !== 'string' || senderId.length > MAX_SENDER_ID) return null;
  if (CONTROL.test(senderId)) return null;
  const id = normalise(source, senderId);
  if (id === '') return null;
  return createHash('sha256').update(`${source}:${id}`).digest('hex').slice(0, 16);
}
