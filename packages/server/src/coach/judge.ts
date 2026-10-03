/**
 * Workflow C's one judgement: is what Bryan is doing right now the moment
 * one of his goals says he wants to act differently?
 *
 * QUIET BY DEFAULT. Models asked when to coach step in far too often: in
 * MetaCLASS (arXiv 2602.02457) they stayed quiet in 4% of cases where quiet
 * was right in 42%. So a moment must name one goal AND quote words from
 * that goal's "Act differently when", and the quote is checked here against
 * the goal's own text. A reply that matches nothing, or is not exactly the
 * expected shape, is quiet.
 */
import { zonedParts } from '@claude-workspaces/core/schedule-timezone';
import { type LearningGoal, goalTitle } from './goals-doc.ts';
import type { CoachMoment } from './types.ts';

export const OBSERVED_MAX_CHARS = 140;
export const LINE_MAX_CHARS = 220;
/** The fewest words a quote of a longer trigger may have. */
const MIN_QUOTE_WORDS = 3;

export function coachSystem(name: string): string {
  return `You are ${name}, a calm coach for one person. He wrote down what he wants to do better, and for each goal the moment he wants to act differently. You see what he is doing on his work pages right now and in the last hour.

Your default is to stay quiet. Speak only when what he is doing right now plainly matches the "Act differently when" of one of his goals. Being near a goal's topic is not a match. Working on a goal is not a match. When you are unsure, stay quiet.

Do not raise the same goal again today if he answered a moment about it with "not now" or "not this". Do not repeat yourself.

Reply with ONE JSON object and nothing else:
{"verdict":"quiet"}
or
{"verdict":"moment","goal":<the goal's number>,"matched":"<words copied exactly from that goal's Act differently when>","observed":"<what you see him doing, at most ${OBSERVED_MAX_CHARS} characters, naming the actual work>","line":"<what you say to him, at most ${LINE_MAX_CHARS} characters: start with \\"Hi, I'm noticing\\", name what he is doing and the goal, and end with one short question>"}

Write to him as "you". No praise, no lecturing, no markdown.`;
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ANSWER_WORDS: Record<CoachMoment['state'], string> = {
  open: 'not answered yet',
  thanks: 'thanks',
  'not-now': 'not now',
  'not-this': 'not this',
  expired: 'no answer',
};

const hhmm = (instant: number, timeZone: string) => {
  const p = zonedParts(instant, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

export function coachPrompt(args: {
  goals: readonly LearningGoal[];
  today: readonly CoachMoment[];
  now: string | null;
  where: readonly string[];
  did: readonly string[];
  at: number;
  timeZone: string;
}): string {
  const p = zonedParts(args.at, args.timeZone);
  const dow = WEEKDAY[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
  const goals = args.goals
    .map(
      (g, i) =>
        `${i + 1}. ${goalTitle(g)}\n   Why: ${g.behind || '(not said)'}\n   Act differently when: ${g.when}\n   Instead: ${g.how || '(not said)'}`,
    )
    .join('\n');
  const moments =
    args.today.length === 0
      ? '(none)'
      : args.today
          .map(
            (m) =>
              `${hhmm(m.at, args.timeZone)} about goal ${m.goalIndex + 1} ("${m.observed}") — his answer: ${ANSWER_WORDS[m.state]}`,
          )
          .join('\n');
  const list = (xs: readonly string[]) => (xs.length ? xs.join('\n') : '(nothing)');
  return `It is ${dow}, ${hhmm(args.at, args.timeZone)} his time.

His goals:
${goals}

Moments you raised today:
${moments}

Right now: ${args.now ?? '(no page open)'}

Where he was in the last hour, oldest first:
${list(args.where)}

What he did in the last hour, one line per doc:
${list(args.did)}`;
}

export type CoachVerdict =
  | { verdict: 'quiet' }
  | { verdict: 'moment'; goalIndex: number; matched: string; observed: string; line: string };

const clean = (s: string) =>
  s
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Lower case, apostrophes and punctuation dropped, single spaces. */
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Are `quote`'s words, in order, a run of the trigger's words? */
export function quotesTrigger(quote: string, trigger: string): boolean {
  const q = words(quote);
  const t = words(trigger);
  if (!q || !t) return false;
  const n = q.split(' ').length;
  if (n < Math.min(MIN_QUOTE_WORDS, t.split(' ').length)) return false;
  return ` ${t} `.includes(` ${q} `);
}

/** The reply as a verdict, or null when it is not exactly one. */
export function parseCoachReply(
  reply: string | null,
  goals: readonly LearningGoal[],
): CoachVerdict | null {
  if (reply === null) return null;
  const body = reply
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let o: unknown;
  try {
    o = JSON.parse(body);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (r.verdict === 'quiet') return { verdict: 'quiet' };
  if (r.verdict !== 'moment') return null;
  const { goal, matched, observed, line } = r;
  if (typeof goal !== 'number' || !Number.isInteger(goal) || goal < 1 || goal > goals.length) {
    return null;
  }
  if (typeof matched !== 'string' || typeof observed !== 'string' || typeof line !== 'string') {
    return null;
  }
  const target = goals[goal - 1];
  if (!target || !quotesTrigger(matched, target.when)) return null;
  const o2 = clean(observed);
  const l = clean(line);
  if (o2.length < 8 || o2.length > OBSERVED_MAX_CHARS) return null;
  if (l.length < 20 || l.length > LINE_MAX_CHARS || !l.endsWith('?')) return null;
  return { verdict: 'moment', goalIndex: goal - 1, matched: clean(matched), observed: o2, line: l };
}
