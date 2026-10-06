/**
 * This week's plan goals, as the coach's digest carries them.
 *
 * The coach judged what comes first from task titles alone. Team Lead's
 * weekly plan already says it: the plan board (`review-plan.ts` names it)
 * holds the week's goals in priority order, and its goal ids are what
 * `rank_review_item` tags asks with. So each digest carries those goals, id
 * and title only, in plan order.
 *
 * A plan is this week's only when it says which week it is: a "Week of
 * <date>" in the board's name, else in one of its goal titles. It is current
 * from that local day for seven days. No plan board, no date, or a week that
 * has passed reads as no current plan, and the digest lists no goals rather
 * than a guess.
 *
 * Pure: the caller hands in the plan board, the instant and the owner's zone.
 */
import { localDay } from './clock.ts';

export interface PlanGoal {
  id: string;
  title: string;
}

/** The plan board as the digest reads it: its name and its goals in order. */
export interface PlanBoardReading {
  name: string;
  goals: readonly PlanGoal[];
}

export const NO_WEEK_PLAN = 'no current week plan';

export type WeekPlan = { week: string; goals: PlanGoal[] } | typeof NO_WEEK_PLAN;

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

const ORD = '(?:st|nd|rd|th)?';
/** "Week of 2026-10-05", "Week of 5 Oct", "Week of Oct 5, 2026". */
const WEEK_OF = new RegExp(
  `\\bweek of\\s+(?:(\\d{4})-(\\d{2})-(\\d{2})|(\\d{1,2})${ORD}\\s+([a-z]{3,})\\.?|([a-z]{3,})\\.?\\s+(\\d{1,2})${ORD})(?:,?\\s+(\\d{4}))?`,
  'i',
);

const monthIndex = (word: string): number =>
  MONTHS.indexOf(word.slice(0, 3).toLowerCase() as (typeof MONTHS)[number]);

/** Day number since the epoch of a calendar date, or NaN when it is not one. */
function dayNumber(year: number, month: number, day: number): number {
  const ms = Date.UTC(year, month, day);
  const d = new Date(ms);
  if (d.getUTCMonth() !== month || d.getUTCDate() !== day) return Number.NaN;
  return ms / 86_400_000;
}

const known = (n: number): number | undefined => (Number.isNaN(n) ? undefined : n);

/**
 * The day a "Week of …" phrase names, as a day number. A date without a
 * year takes the year that puts it nearest `today`, so a plan written in late
 * December for the first week of January reads right.
 */
export function weekStartOf(text: string, today: number): number | undefined {
  const m = WEEK_OF.exec(text);
  if (!m) return undefined;
  const [, isoY, isoM, isoD, dayA, monthA, monthB, dayB, year] = m;
  if (isoY) return known(dayNumber(Number(isoY), Number(isoM) - 1, Number(isoD)));
  const month = monthIndex(monthA ?? monthB ?? '');
  const day = Number(dayA ?? dayB);
  if (month < 0) return undefined;
  if (year) return known(dayNumber(Number(year), month, day));
  const thisYear = new Date(today * 86_400_000).getUTCFullYear();
  let best: number | undefined;
  for (const y of [thisYear - 1, thisYear, thisYear + 1]) {
    const n = known(dayNumber(y, month, day));
    if (n === undefined) continue;
    if (best === undefined || Math.abs(n - today) < Math.abs(best - today)) best = n;
  }
  return best;
}

const isoOf = (dayNum: number): string => new Date(dayNum * 86_400_000).toISOString().slice(0, 10);

/** The goals of the plan for the week `now` falls in, or `NO_WEEK_PLAN`. */
export function weekPlanOf(
  board: PlanBoardReading | undefined,
  now: number,
  timeZone: string,
): WeekPlan {
  if (!board) return NO_WEEK_PLAN;
  const [y, m, d] = localDay(now, timeZone).split('-').map(Number);
  const today = dayNumber(y ?? 0, (m ?? 1) - 1, d ?? 1);
  const start =
    weekStartOf(board.name, today) ??
    board.goals.map((g) => weekStartOf(g.title, today)).find((n) => n !== undefined);
  if (start === undefined || today < start || today >= start + 7) return NO_WEEK_PLAN;
  return { week: isoOf(start), goals: board.goals.map((g) => ({ id: g.id, title: g.title })) };
}
