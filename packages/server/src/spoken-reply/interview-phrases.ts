/**
 * What an interview hears as a command rather than an answer.
 *
 * Whole-utterance matches only, after the wake word and filler are off: an
 * answer that happens to contain "skip" ("we skip the staging deploy") is an
 * answer, and is written. That is why every pattern is anchored at both ends.
 *
 *  - `start`: "interview me", and the ways of saying it.
 *  - `skip`: move to the next gap and leave this one.
 *  - `later`: "come back to that" — the gap goes to the end of the queue.
 *  - `enough`: "that's enough" — the interview ends, and what was written stays.
 *  - `repeat`: "say that again" — the same question, asked again.
 *  - `unsure`: "I don't know yet" — no answer and no reason to press for
 *    one, so the planning voice says nothing and asks its next question at
 *    the next pause.
 */
export type InterviewCommand = 'start' | 'skip' | 'later' | 'enough' | 'repeat' | 'unsure';

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:(?:hey|hi|ok|okay|so)\s+)?claude\s+/, '')
    .replace(/^(?:um+|uh+|er+|erm|ok|okay|so|well|alright|all right|right)\s+/, '')
    .replace(/\s+(?:please|thanks|thank you|claude)$/, '')
    .replace(/^(?:please|can you|could you|let's|lets)\s+/, '')
    .trim();
}

const PATTERNS: ReadonlyArray<[InterviewCommand, RegExp]> = [
  [
    'start',
    /^(?:interview me|start (?:the |an )?interview|(?:begin|do|run) (?:the |an )?interview|interview me (?:on|about) (?:this|the|my) (?:plan|doc|document))$/,
  ],
  [
    'skip',
    /^(?:skip(?: it| that| this(?: one)?| that one)?|next(?: one| question)?|pass|move on|skip for now)$/,
  ],
  [
    'later',
    /^(?:(?:let's |lets |i'll |we'll )?come back to (?:that|it|this)(?: later)?|ask me (?:that |again )?later|later|leave (?:that|it|this) for (?:now|later)|park (?:that|it|this))$/,
  ],
  [
    'enough',
    /^(?:that's enough|that is enough|thats enough|enough(?: for now)?|that's all(?: for now)?|that is all|stop(?: the interview| interviewing(?: me)?)?|end(?: the)? interview|we're done|were done|i'm done|im done|done for now|let's stop(?: there)?|lets stop(?: there)?)$/,
  ],
  [
    'repeat',
    /^(?:say (?:that|it) again|repeat (?:that|the question)|what was the question|sorry what|what|pardon|come again)$/,
  ],
  [
    'unsure',
    /^(?:(?:i |we )?(?:don't|dont|do not) know(?: yet)?|no idea(?: yet)?|(?:i'm |im |i am )?not sure(?: yet)?|let me think(?: about (?:that|it))?|not yet|(?:i |we )?(?:haven't|havent) decided(?: yet)?|still deciding|good question|hmm+|hm+)$/,
  ],
];

/** An answer that says nothing yet: the planning voice asks once for more. */
const BARE =
  /^(?:yes|yeah|yep|yup|no|nope|maybe|probably|possibly|perhaps|sure|kind of|sort of|i think so|i guess|i guess so|it depends|depends|right|ok|okay|correct|exactly|same as before|the usual)$/;

/** Whether `transcript` is a bare yes, no or maybe rather than an answer. */
export function bareAnswer(transcript: string): boolean {
  return BARE.test(normalize(transcript));
}

/** The command `transcript` is, or null when it is an answer. "Any
 *  questions?" with a question already out asks for that one again. */
export function interviewCommand(transcript: string): InterviewCommand | null {
  const s = normalize(transcript);
  if (!s) return null;
  for (const [cmd, re] of PATTERNS) if (re.test(s)) return cmd;
  return INVITE.test(s) ? 'repeat' : null;
}

/** "Any questions?" at the end of what was said, however it is put. */
const INVITE =
  /(?:^|\s)(?:(?:(?:do|did|would) you have|have you got|you got|any)\s+(?:any\s+)?(?:more |other |further )?questions?(?: for me| so far| about (?:this|that|it|the plan))?|what questions do you have(?: for me)?|anything (?:you want )?to ask(?: me)?)$/;

/** Whether the speaker just asked the planning voice for its questions. */
export function asksForQuestions(transcript: string): boolean {
  return INVITE.test(normalize(transcript));
}

/** The longest answer written, in characters. */
export const MAX_ANSWER_CHARS = 4000;

/** A spoken answer as one markdown paragraph: a leading `#`, `-`, `>` or
 *  `1.` would otherwise make it a heading, a list or a quote. */
export function answerMarkdown(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim().slice(0, MAX_ANSWER_CHARS);
  return flat.replace(/^([#>*+-]|\d+[.)])/, '\\$1');
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
