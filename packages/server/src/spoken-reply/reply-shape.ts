/**
 * What of the router's answer is said, and what is only written.
 *
 * The plan's first rule is "say less, write more": the voice gives the
 * headline and the question, and the page carries the rest. The router
 * (`voice.ts`) answers in prose built for reading — "Heard: …", then the
 * answer, often several sentences — so this cuts it in two:
 *
 *  - a QUESTION is said on its own. "Did you mean A or B? Say first or
 *    second…" speaks the first sentence and writes the second, so a
 *    follow-up is one spoken question and then silence.
 *  - anything else speaks its first two sentences. When a status brief has a
 *    "Waiting on you" sentence, that one is the second: what changed, then
 *    what needs you.
 *
 * `SPOKEN_MAX_WORDS` is the hard cap under both rules, cut on a word
 * boundary, because a runaway sentence read aloud costs far more than one
 * left on the screen.
 */
import { SPOKEN_MAX_WORDS } from '@claude-workspaces/core/spoken-reply';

export interface ShapedReply {
  spoken: string;
  detail: string[];
  asking: boolean;
}

/**
 * The wake phrase, off the front: "Claude, give me a status update" is the
 * request "give me a status update". The router's own patterns are whole-
 * utterance, so without this the most natural way to ask would miss them.
 */
export function stripWake(transcript: string): string {
  const stripped = transcript
    .trim()
    .replace(/^(?:(?:hey|hi|ok|okay|so)[\s,]+)?claude\b[\s,.!:;-]*/i, '')
    .trim();
  return stripped || transcript.trim();
}

/** The router's `Heard: "…".` prefix is for a reader checking the mic, and
 *  the page shows what was heard already. Never spoken. */
function withoutHeard(ack: string): string {
  return ack.replace(/^\s*Heard: ".*?"\.\s*/s, '').trim();
}

/** Sentences, split after `.`, `?` or `!` where the next one starts. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!…])\s+(?=[A-Z0-9“"‘'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function capSpoken(text: string): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length <= SPOKEN_MAX_WORDS) return text;
  return `${words.slice(0, SPOKEN_MAX_WORDS).join(' ')}…`;
}

export function shapeReply(ack: string): ShapedReply {
  const all = sentences(withoutHeard(ack));
  if (all.length === 0) return { spoken: '', detail: [], asking: false };
  const q = all.findIndex((s) => s.endsWith('?'));
  if (q >= 0) {
    const question = all[q] ?? '';
    return {
      spoken: capSpoken(question),
      detail: all.filter((_, i) => i !== q),
      asking: true,
    };
  }
  const first = all[0] ?? '';
  const waiting = all.findIndex((s, i) => i > 0 && /^Waiting on you\b/.test(s));
  const second = waiting > 0 ? waiting : all.length > 1 ? 1 : -1;
  const spokenParts = second > 0 ? [first, all[second] ?? ''] : [first];
  return {
    spoken: capSpoken(spokenParts.join(' ')),
    detail: all.filter((_, i) => i !== 0 && i !== second),
    asking: false,
  };
}
