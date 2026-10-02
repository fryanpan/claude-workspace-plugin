/**
 * The words the voice review queue listens for, apart from the answers
 * themselves: starting the queue, yes and no to a read-back, undo, skip,
 * stop, repeat, and whether something said is a question.
 *
 * Every matcher takes the transcript whole, normalised, and matches the
 * whole of it (or, for yes and no, its first words), so "no" inside an
 * answer ("no more than two") is never read as a refusal.
 */
import { answerAsksBack } from '@claude-workspaces/core';

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const START: readonly RegExp[] = [
  /^(?:let's |lets |can we |can you |please )?(?:go|walk|run|work|read)(?: me)? through (?:my |the |our )?(?:reviews?|review (?:queue|items?)|queue|decisions?)(?: with me)?(?: please)?$/,
  /^(?:let's |lets )?(?:start|begin|do|open)(?: my| the| our)? (?:reviews?|review queue|decisions)$/,
  /^(?:my )?(?:reviews?|review queue)(?: please)?$/,
];

/** "go through my reviews" — the request that starts the queue. */
export function startsWalk(transcript: string): boolean {
  const s = normalize(transcript);
  return START.some((p) => p.test(s));
}

const YES =
  /^(?:yes|yeah|yep|yup|ok|okay|sure|correct|confirm|confirmed|right|do it|go ahead|that's right|thats right|record it|sounds good|exactly)(?: (?:please|thanks|record it|do it|go ahead|that's right))*$/;

export function isYes(transcript: string): boolean {
  return YES.test(normalize(transcript));
}

const NO_HEAD =
  /^(?:no|nope|nah|wait|hold on|hang on|cancel|not that|don't|dont|actually)(?: (?:no|wait|sorry|actually))*\b/;

/** The words after a refusal ("no, the second one" → "the second one"), ''
 *  for a bare refusal, or null when this is not one. */
export function refusal(transcript: string): string | null {
  const s = normalize(transcript);
  const m = s.match(NO_HEAD);
  if (!m) return null;
  return s.slice(m[0].length).trim();
}

const UNDO =
  /^(?:(?:no )?(?:undo|undo that|undo it|take that back|take it back|scratch that|reverse that|that's wrong|thats wrong))(?: please)?$/;

/** "undo that", and — just after a decision was recorded — a bare "no" or
 *  "wait", which is what the read-back promised would take it back. */
export function undoes(transcript: string): boolean {
  const s = normalize(transcript);
  if (UNDO.test(s)) return true;
  return refusal(transcript) === '';
}

const SKIP =
  /^(?:skip|skip it|skip this(?: one)?|next|next one|later|leave it|leave that|pass|move on|not now)(?: please)?$/;

export function skips(transcript: string): boolean {
  return SKIP.test(normalize(transcript));
}

const STOP =
  /^(?:stop|done|that's all|thats all|that's it|thats it|exit|quit|end|i'm done|im done|finish|enough|stop reviews?|stop the reviews?)(?: (?:for now|thanks|thank you))*$/;

export function stops(transcript: string): boolean {
  return STOP.test(normalize(transcript));
}

const REPEAT =
  /^(?:repeat|repeat that|again|say that again|say it again|what was that|come again|pardon|sorry)$/;

export function repeats(transcript: string): boolean {
  return REPEAT.test(normalize(transcript));
}

const QUESTION_HEAD =
  /^(?:what|why|who|how|when|where|which|is|are|does|do|did|can|could|should|would|will|tell me|explain)\b/;

/**
 * A question about the item rather than an answer to it. The routes read a
 * typed answer ending in "?" as an ask-back (`answerAsksBack`), and spoken
 * words often arrive without the mark, so an opening question word counts
 * too.
 */
export function asksAbout(transcript: string): boolean {
  return answerAsksBack(transcript) || QUESTION_HEAD.test(normalize(transcript));
}
