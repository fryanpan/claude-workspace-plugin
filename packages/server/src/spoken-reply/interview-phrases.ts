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
 */
export type InterviewCommand = 'start' | 'skip' | 'later' | 'enough' | 'repeat';

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
    /^(?:skip(?: it| that| this(?: one)?| that one)?|next(?: one| question)?|pass|move on|i don't know|no idea|not sure|skip for now)$/,
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
];

/** The command `transcript` is, or null when it is an answer. */
export function interviewCommand(transcript: string): InterviewCommand | null {
  const s = normalize(transcript);
  if (!s) return null;
  for (const [cmd, re] of PATTERNS) if (re.test(s)) return cmd;
  return null;
}
