/**
 * A review item that STOPS work: the asker is idle until the reader answers.
 *
 * Bryan, 2026-10-07: "If there's an issue with a deadline, then that should
 * be front and center immediately while I'm asking for the thing. Not as a
 * review item some time later where it gets lost." An agent that stopped
 * work to ask filed an item that read like every other one, and it sat on
 * Home for two days with the work idle. The field is how the asker says so,
 * and these helpers are the one reading of it every surface shares: the
 * queue order, the Home row's line and the push title.
 *
 * Bryan, 2026-10-08: "Well team lead should still rank. But yeah agent
 * should be able to identify that an ask blocks work on a top goal." So the
 * field never outranks the lead; it carries the stopped work's goal
 * (`goalId`) so the lead can see what the wait costs when it ranks.
 *
 * Pure and dependency-free, like the rest of the review-item contract.
 */
import type { ReviewBlocks, ReviewPayload } from './review-item-types.ts';

/** Room for a short phrase naming the stopped work, and no more: it is shown
 *  after a fixed prefix on one Home row and in a lock-screen title. */
export const REVIEW_BLOCKS_WHAT_MAX = 120;
/** Two weeks. Longer than that is not "stopped until you answer". */
export const REVIEW_BLOCKS_HOURS_MAX = 24 * 14;

/** The fixed words in front of `what`, on the Home row and in the push. */
export const BLOCKS_LINE_PREFIX = 'Stopped until you answer: ';
/** The words in front of the stopped goal's title, after `what`. */
export const BLOCKS_GOAL_PREFIX = ' — stops work on ';

/** Goal ids are minted ids: short, no spaces. Anything else reads as absent. */
const GOAL_ID = /^[\w-]{1,64}$/;

/**
 * `blocks`, read off an untrusted payload. A malformed value reads as absent
 * rather than throwing: an item that cannot say what it holds up is an
 * ordinary item, and must still render.
 */
export function readReviewBlocks(value: unknown): ReviewBlocks | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.what !== 'string') return undefined;
  const what = raw.what.replace(/\s+/g, ' ').trim();
  if (what === '') return undefined;
  const out: ReviewBlocks = {
    what:
      what.length <= REVIEW_BLOCKS_WHAT_MAX
        ? what
        : `${what.slice(0, REVIEW_BLOCKS_WHAT_MAX - 1).trimEnd()}…`,
  };
  const hours = raw.hours;
  if (typeof hours === 'number' && Number.isFinite(hours) && hours > 0) {
    out.hours = Math.min(hours, REVIEW_BLOCKS_HOURS_MAX);
  }
  if (typeof raw.goalId === 'string' && GOAL_ID.test(raw.goalId)) out.goalId = raw.goalId;
  return out;
}

/**
 * `review` with its stopped work's goal stamped on, at filing. `goalId` is
 * the one the server resolved — the item's task's goal, else the asker's own
 * once it is known to exist — and undefined drops whatever the asker sent.
 * An item that stops nothing is returned unchanged.
 */
export function withBlocksGoal<T extends Pick<ReviewPayload, 'blocks'>>(
  review: T,
  goalId: string | undefined,
): T {
  if (!review.blocks) return review;
  const { goalId: _asked, ...blocks } = review.blocks;
  return { ...review, blocks: goalId ? { ...blocks, goalId } : blocks };
}

/** Does this item, while open, hold up work? */
export function isBlockingAsk(review: Pick<ReviewPayload, 'blocks'> | undefined): boolean {
  return review?.blocks !== undefined;
}

/** The one steady line a blocking item carries, or undefined for any other.
 *  `goal` is the stopped goal's title, when the reader can name it. */
export function blocksLine(
  review: Pick<ReviewPayload, 'blocks'> | undefined,
  goal?: string,
): string | undefined {
  const what = review?.blocks?.what;
  if (what === undefined) return undefined;
  return `${BLOCKS_LINE_PREFIX}${what}${goal ? `${BLOCKS_GOAL_PREFIX}${goal}` : ''}`;
}
