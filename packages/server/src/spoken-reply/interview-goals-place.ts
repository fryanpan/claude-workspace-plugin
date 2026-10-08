/**
 * Where what was said on a learning-goals doc belongs: the coach's name, new
 * goals, or a change to a goal already written.
 *
 * The owner talks about several goals at once and goes back to earlier ones
 * ("actually, change the first one to…"), so an answer is never fitted to
 * the question that is out. One model call reads the doc's goals, numbered,
 * and what was said, and names every change. Without a model, or when it
 * fails or answers off-format, a short rule does: "change goal 2 to …" is a
 * revision, a reply to the name question is a name, and anything else is
 * one new goal in the speaker's words.
 */
import { nameFrom } from '../coach/goals-doc.ts';
import type { PlanComplete } from './interview-reader.ts';

export interface GoalsPlacement {
  name: string | null;
  add: string[];
  /** `goal` is 1-based, as the prompt numbers them. */
  change: Array<{ goal: number; text: string }>;
}

export interface GoalsHeard {
  name: string;
  goals: readonly string[];
  /** The question out, if one is. */
  asked: 'name' | 'better' | null;
  heard: string;
}

const HEARD_CHARS = 2_000;
const GOAL_CHARS = 600;

export const GOALS_SYSTEM = [
  'A person is setting up their learning goals out loud, for a coach that watches their work.',
  'The doc holds the coach’s name and a numbered list of goals: each is one thing they want to do',
  'better, usually with when the coach should speak up.',
  'From what they just said, name every change to the doc. They may name the coach, add several',
  'goals at once, or revise an earlier goal ("change the first one to…"), in any order.',
  'Keep their own words; join a goal’s pieces into one sentence or two, but never invent.',
  'A remark about the tool, the voice or the screen changes nothing.',
  'Reply with JSON only:',
  '{"name": "<the coach’s new name, or null>", "add": ["<one new goal>"], "change": [{"goal": <its number>, "text": "<the goal as it should now read>"}]}',
].join('\n');

export function goalsPrompt(h: GoalsHeard): { system: string; user: string } {
  const goals = h.goals.length ? h.goals.map((g, i) => `${i + 1}. ${g}`).join('\n') : '(none)';
  const asked = h.asked === 'name' ? 'the coach’s name' : h.asked ? 'what to do better' : '(none)';
  return {
    system: GOALS_SYSTEM,
    user: [
      `COACH NAME: ${h.name || '(none)'}`,
      `GOALS:\n${goals}`,
      `QUESTION OUT: ${asked}`,
      `JUST SAID:\n${h.heard.trim().slice(-HEARD_CHARS)}`,
    ].join('\n\n'),
  };
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, GOAL_CHARS);

/** The model's reply as a placement, or null off-format. */
export function parsePlacement(raw: string, goals: number): GoalsPlacement | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  const name = typeof m.name === 'string' && clean(m.name) ? clean(m.name) : null;
  const add = Array.isArray(m.add)
    ? m.add
        .filter((g): g is string => typeof g === 'string')
        .map(clean)
        .filter(Boolean)
    : [];
  const change = Array.isArray(m.change)
    ? m.change.flatMap((c) => {
        const { goal, text } = (c ?? {}) as Record<string, unknown>;
        if (typeof goal !== 'number' || !Number.isInteger(goal) || goal < 1 || goal > goals)
          return [];
        return typeof text === 'string' && clean(text) ? [{ goal, text: clean(text) }] : [];
      })
    : [];
  return { name, add, change };
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
const REVISE =
  /^(?:actually[,\s]+)?(?:change|make|update)\s+(?:the\s+)?(?:goal\s+)?(first|second|third|fourth|fifth|sixth|\d+)(?:\s+(?:one|goal))?\s+(?:to|into)\s+(.+)$/i;

/** The rule a placement falls back on. */
export function placeByRule(h: GoalsHeard): GoalsPlacement {
  const said = clean(h.heard);
  const revise = REVISE.exec(said);
  if (revise) {
    const which = (revise[1] ?? '').toLowerCase();
    const goal = ORDINALS.includes(which) ? ORDINALS.indexOf(which) + 1 : Number(which);
    const text = clean(revise[2] ?? '');
    const upper = text.charAt(0).toUpperCase() + text.slice(1);
    if (goal >= 1 && goal <= h.goals.length && text) {
      return { name: null, add: [], change: [{ goal, text: upper }] };
    }
  }
  if (h.asked === 'name') return { name: nameFrom(said) ?? null, add: [], change: [] };
  return { name: null, add: said ? [said] : [], change: [] };
}

/** Every change what was said makes to the goals doc. */
export async function placeGoals(
  complete: PlanComplete | undefined,
  h: GoalsHeard,
): Promise<GoalsPlacement> {
  if (complete) {
    try {
      const placed = parsePlacement(await complete(goalsPrompt(h)), h.goals.length);
      if (placed) return placed;
    } catch {
      // A model that fails loses the reading, not the words.
    }
  }
  return placeByRule(h);
}
