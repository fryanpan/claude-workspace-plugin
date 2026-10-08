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
  return out;
}

/** Does this item, while open, hold up work? */
export function isBlockingAsk(review: Pick<ReviewPayload, 'blocks'> | undefined): boolean {
  return review?.blocks !== undefined;
}

/** The one steady line a blocking item carries, or undefined for any other. */
export function blocksLine(review: Pick<ReviewPayload, 'blocks'> | undefined): string | undefined {
  const what = review?.blocks?.what;
  return what === undefined ? undefined : `${BLOCKS_LINE_PREFIX}${what}`;
}
