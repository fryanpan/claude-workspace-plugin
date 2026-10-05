/**
 * The judge's reason as it is stored: one sentence, clipped.
 *
 * Out of `review-judge-prompt.ts` only to keep that file under the line
 * limit; the prompt's parser is its one caller.
 */

/** The longest reason stored or shown. A judge that writes an essay is
 *  clipped rather than refused — the verdict is the load-bearing half. */
export const REVIEW_JUDGE_REASON_MAX = 300;

/**
 * One sentence as it is stored: whitespace collapsed, cut after the first
 * sentence, clipped at the ceiling. `''` for anything that is not a string
 * with words in it.
 *
 * The cut is not cosmetic. Every surface downstream builds a longer sentence
 * around this one — the hold message, the card's "Held: …", the admitted-
 * after-two-holds note — and a judge that answered with a paragraph put a
 * full stop in the middle of all of them. Asking for one sentence in the
 * prompt is not enforcement; this is.
 *
 * A terminator only ends the sentence when a SPACE or the end of the string
 * follows it, which is what keeps "v1.2" and "e.g. what is blocked" whole
 * — the common false cut, and the reason a bare `split('.')` is wrong here.
 * Text with no terminator at all is one sentence and is kept entire.
 */
export function clipSentence(value: unknown): string {
  const text = (typeof value === 'string' ? value : '').trim().replace(/\s+/g, ' ');
  const first = firstSentence(text);
  return first.length > REVIEW_JUDGE_REASON_MAX
    ? `${first.slice(0, REVIEW_JUDGE_REASON_MAX - 1)}\u2026`
    : first;
}

/**
 * Abbreviations whose full stop is not a sentence end. Short list on purpose:
 * it only has to cover what a judge writing one sentence of English about a
 * review item actually types.
 */
const NOT_A_SENTENCE_END = new Set(['e.g.', 'i.e.', 'etc.', 'vs.', 'cf.', 'no.', 'fig.']);

/**
 * The first sentence of `text`, terminator included. See `clipSentence`.
 *
 * A cut needs THREE things, and each one is a false cut this function was
 * given a test for: a terminator, whitespace after it (so "v1.2" survives),
 * something that looks like the start of a new sentence after that (so
 * "e.g. what is blocked" survives), and a preceding word that is not a known
 * abbreviation (so "e.g. What is blocked" survives too). When no cut
 * qualifies, the whole string is one sentence — erring toward keeping words,
 * never toward mangling them.
 */
function firstSentence(text: string): string {
  const terminator = /[.?!\u2026]+(?=\s)/g;
  for (let m = terminator.exec(text); m !== null; m = terminator.exec(text)) {
    const cut = m.index + m[0].length;
    const rest = text.slice(cut).trimStart();
    // The terminator ends the whole string: no second sentence to drop.
    if (rest === '') return text;
    // What follows has to look like a sentence opening.
    if (!/^[A-Z0-9“"'(\[]/.test(rest)) continue;
    const word = text.slice(0, cut).split(' ').at(-1)?.toLowerCase() ?? '';
    if (NOT_A_SENTENCE_END.has(word)) continue;
    return text.slice(0, cut);
  }
  return text;
}
