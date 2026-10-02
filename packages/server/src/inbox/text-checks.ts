/**
 * The checks on the words a reader posts.
 *
 * A message can carry instructions to the reader, so the reader's own
 * summary is no more trusted than the message. Two kinds of field:
 *
 *  - **Line text** (`senderLabel`, `purpose`) is shown on the line itself.
 *    It is refused, not cleaned, when it carries anything that could become
 *    markup, a link or an address: a reader that wrote one has been steered,
 *    and a cleaned version would still say what the attacker chose.
 *  - **The message** (`body`) is shown only when Bryan opens the line, as
 *    plain text. Real mail carries control and direction characters, so
 *    those are stripped rather than refused, and URLs and markup are kept as
 *    text: the page never turns them into anything.
 *
 * Every check runs on the NFC form, and the refusals run on the NFKC form as
 * well, so a fullwidth `＜` or `＠` is caught as the character it looks like.
 */

/** C0 and C1 controls, and the format characters: direction overrides and
 *  isolates, zero-width joiners, the byte-order mark. */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const CONTROL_OR_FORMAT_ALL = /[\p{Cc}\p{Cf}]/gu;

/** What makes line text refused, each with the reason the reader is told. */
const REFUSED: ReadonlyArray<readonly [RegExp, string]> = [
  [/[<>]/, 'markup'],
  [/`/, 'backtick'],
  [/\[/, 'bracket'],
  [/:\/\//, 'link'],
  [/www\./i, 'link'],
  [/mailto:/i, 'link'],
  // An `@` followed by something shaped like a domain: an email address or a
  // handle on a host. A bare `@` ("meet @ 3") is fine.
  [/@\s*[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u, 'address'],
];

export const codePoints = (s: string): number => [...s].length;

export type TextVerdict = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Line text: NFC, trimmed, between 1 and `max` code points, and free of
 * everything in `REFUSED`, controls and format characters.
 */
export function checkLineText(raw: unknown, max: number): TextVerdict {
  if (typeof raw !== 'string') return { ok: false, reason: 'not text' };
  const value = raw.normalize('NFC').trim();
  const n = codePoints(value);
  if (n === 0) return { ok: false, reason: 'empty' };
  if (n > max) return { ok: false, reason: `over ${max} characters` };
  if (CONTROL_OR_FORMAT.test(value)) return { ok: false, reason: 'control character' };
  const folded = value.normalize('NFKC');
  for (const [pattern, reason] of REFUSED) {
    if (pattern.test(value) || pattern.test(folded)) return { ok: false, reason };
  }
  return { ok: true, value };
}

/** A sender's display name: line text, plus no phone number and at most one
 *  sentence-ending mark, so it cannot be a sentence aimed at Bryan. */
export function checkSenderLabel(raw: unknown): TextVerdict {
  const v = checkLineText(raw, 48);
  if (!v.ok) return v;
  if ((v.value.normalize('NFKC').match(/\d/g) ?? []).length >= 7) {
    return { ok: false, reason: 'phone number' };
  }
  if ((v.value.match(/[.!?]/g) ?? []).length > 1) return { ok: false, reason: 'sentence' };
  return v;
}

export const BODY_MAX = 4000;

/**
 * The message: NFC, controls and format characters removed (newlines and
 * tabs kept), cut to `BODY_MAX` code points with a trailing "…" when cut.
 */
export function cleanBody(raw: unknown): TextVerdict {
  if (typeof raw !== 'string') return { ok: false, reason: 'not text' };
  const cleaned = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_OR_FORMAT_ALL, (c) => (c === '\n' || c === '\t' ? c : ''))
    .trim();
  const chars = [...cleaned];
  if (chars.length === 0) return { ok: false, reason: 'empty' };
  if (chars.length <= BODY_MAX) return { ok: true, value: cleaned };
  return { ok: true, value: `${chars.slice(0, BODY_MAX - 1).join('')}…` };
}
