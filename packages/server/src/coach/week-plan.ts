/**
 * This week's plan goals, as the coach's digest carries them.
 *
 * The coach judged what comes first from task titles alone. Team Lead's
 * weekly plan already says it: the plan board (`review-plan.ts` names it)
 * holds the week's goals in board order, Team Lead resets that list each
 * week, and its goal ids are what `rank_review_item` tags asks with. So each
 * digest carries those goals, id and title only, in that order.
 *
 * Nothing is read out of a title: a date parsed from a name breaks the first
 * time somebody renames the board. When the list was last set is the newest
 * `updatedAt` of its goal rows, which a retitle, a reorder and a new goal all
 * move. Past eight days the goals still go, marked as possibly stale. No plan
 * board, or a board with no goals, is no current plan.
 *
 * Pure: the caller hands in the plan board, the instant and the owner's zone.
 */
import { isArchived } from '../task-fields.ts';
import { localDay } from './clock.ts';

export interface PlanGoal {
  id: string;
  title: string;
}

/** One of the plan board's goals, with when its row last changed. */
export interface PlanBoardGoal extends PlanGoal {
  changedAt?: number;
}

/** The plan board as the digest reads it: its goals in board order. */
export interface PlanBoardReading {
  goals: readonly PlanBoardGoal[];
}

export const NO_WEEK_PLAN = 'no current week plan';

export type WeekPlan =
  | {
      /** The owner's local day the list was last set, `YYYY-MM-DD`. */
      set?: string;
      /** Set more than `STALE_AFTER_MS` ago. */
      stale?: true;
      goals: PlanGoal[];
    }
  | typeof NO_WEEK_PLAN;

/** A weekly list older than this has probably missed its reset. */
export const STALE_AFTER_MS = 8 * 86_400_000;

/** Bands that are not part of the week's plan: the reserved backlog, and the
 *  boards' standing decision and urgent bands. */
const NOT_PLAN_IDS = new Set(['chores']);
const NOT_PLAN_TITLES = new Set(['decisions', 'urgent']);

const inPlan = (g: PlanGoal): boolean =>
  !NOT_PLAN_IDS.has(g.id) && !NOT_PLAN_TITLES.has(g.title.trim().toLowerCase());

/**
 * The board's goals in board order, each with when its row last changed. An
 * archived band stays in the goal list but is off the board, so it is left
 * out; a goal with no row yet goes without a time.
 */
export function planBoardReading(
  goals: readonly PlanGoal[],
  rows: readonly { id: string; updatedAt: number; archivedAt?: number }[],
): PlanBoardReading {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    goals: goals.flatMap((g) => {
      const row = byId.get(g.id);
      if (row && isArchived(row)) return [];
      return [{ id: g.id, title: g.title, ...(row ? { changedAt: row.updatedAt } : {}) }];
    }),
  };
}

/** The plan board's goals for the digest, or `NO_WEEK_PLAN`. */
export function weekPlanOf(
  board: PlanBoardReading | undefined,
  now: number,
  timeZone: string,
): WeekPlan {
  const goals = (board?.goals ?? []).filter(inPlan);
  if (goals.length === 0) return NO_WEEK_PLAN;
  const times = goals.flatMap((g) => (g.changedAt === undefined ? [] : [g.changedAt]));
  const setAt = times.length > 0 ? Math.max(...times) : undefined;
  return {
    ...(setAt === undefined ? {} : { set: localDay(setAt, timeZone) }),
    ...(setAt !== undefined && now - setAt > STALE_AFTER_MS ? { stale: true as const } : {}),
    goals: goals.map((g) => ({ id: g.id, title: g.title })),
  };
}
