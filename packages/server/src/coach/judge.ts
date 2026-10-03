/**
 * The coach's one judgement: did today's work drift from this week's goals?
 *
 * The prompt carries the goals, the nudges already raised today with
 * Bryan's answers, and the day's activity lines. The reply is one JSON
 * object, and anything that is not exactly the expected shape is refused,
 * so a malformed or chatty reply raises no nudge rather than a strange one.
 * Being wrong by staying quiet is the cheaper mistake: "calm by default".
 */
import { zonedParts } from '@claude-workspaces/core/schedule-timezone';
import type { CoachNudge } from './types.ts';

export const DRIFT_MAX_CHARS = 140;
export const QUESTION_MAX_CHARS = 180;

export const COACH_SYSTEM = `You are a calm work coach for one person. Each week he names up to three goals, most important first. A few times a day you read what he worked on today and decide whether his time is still serving those goals.

Call it drift only when most of today's time went to work that serves none of the goals, or to easier or lower-priority work while the first goal got little or no time. Going deep on something that plainly serves a goal is not drift. Short looks at other things are not drift. When you are unsure, it is on track.

If he already answered a nudge today with "plans changed", do not nudge about the same goal again today. Do not repeat a nudge he answered with "back to it" unless the drift has clearly continued since.

Reply with ONE JSON object and nothing else:
{"verdict":"on-track"}
or
{"verdict":"drift","goal":<the goal's number>,"drift":"<what the time went to instead, at most ${DRIFT_MAX_CHARS} characters, naming the actual work>","question":"<one plain question, at most ${QUESTION_MAX_CHARS} characters, asking whether he is still pursuing that goal>"}

Write to him as "you". No praise, no lecturing, no markdown.`;

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ANSWER_WORDS: Record<CoachNudge['state'], string> = {
  open: 'not answered yet',
  'back-to-it': 'back to it',
  'plans-changed': 'plans changed',
  expired: 'not answered',
};

export function coachPrompt(args: {
  goals: readonly string[];
  today: readonly CoachNudge[];
  lines: readonly string[];
  now: number;
  timeZone: string;
}): string {
  const p = zonedParts(args.now, args.timeZone);
  const dow = WEEKDAY[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
  const time = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  const goals = args.goals.map((g, i) => `${i + 1}. ${g}`).join('\n');
  const nudges =
    args.today.length === 0
      ? '(none)'
      : args.today
          .map((n) => {
            const at = zonedParts(n.at, args.timeZone);
            const when = `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`;
            return `${when} about goal ${n.goalIndex + 1}: "${n.drift}" — his answer: ${ANSWER_WORDS[n.state]}`;
          })
          .join('\n');
  return `It is ${dow} ${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}, ${time} his time.

This week's goals, most important first:
${goals}

Nudges already raised today:
${nudges}

What he worked on today, one line per doc, oldest first:
${args.lines.join('\n')}`;
}

export type CoachVerdict =
  | { verdict: 'on-track' }
  | { verdict: 'drift'; goalIndex: number; drift: string; question: string };

const clean = (s: string) =>
  s
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The reply as a verdict, or null when it is not exactly one. */
export function parseCoachReply(reply: string | null, goalCount: number): CoachVerdict | null {
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
  if (r.verdict === 'on-track') return { verdict: 'on-track' };
  if (r.verdict !== 'drift') return null;
  const { goal, drift, question } = r;
  if (typeof goal !== 'number' || !Number.isInteger(goal) || goal < 1 || goal > goalCount) {
    return null;
  }
  if (typeof drift !== 'string' || typeof question !== 'string') return null;
  const d = clean(drift);
  const q = clean(question);
  if (d.length < 8 || d.length > DRIFT_MAX_CHARS) return null;
  if (q.length < 12 || q.length > QUESTION_MAX_CHARS || !q.endsWith('?')) return null;
  return { verdict: 'drift', goalIndex: goal - 1, drift: d, question: q };
}
