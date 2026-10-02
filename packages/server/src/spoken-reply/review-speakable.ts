/**
 * Which review items can be decided by voice, and which stay for the screen.
 *
 * An item goes through the voice queue only when Claude can state it in a
 * sentence or two and the speaker can answer it without looking at anything.
 * The rule is mechanical, so it can be tested and so the speaker can learn
 * it. An item needs the screen when:
 *
 *  - it is not a declared review item: an inferred ask on a thread has no
 *    headline or options to read (`not-an-item`);
 *  - it is a secret or a grant, which only its own card may answer
 *    (`card-only`; the routes refuse them anyway);
 *  - it asks to be looked at: it hangs on a mock or a diff, or its detail
 *    carries an image, a code block, or a link to a mock, a diff review or a
 *    pull request (`something-to-see`);
 *  - it offers more than `MAX_SPOKEN_OPTIONS` options (`many-options`);
 *  - its headline and option labels together run past `SPOKEN_MAX_WORDS`,
 *    the same cap every spoken reply has (`too-long`).
 *
 * Links to a task or a plain doc do not count: they are context, and the
 * detail is read on request.
 */
import { extractWorkspaceLinks } from '@claude-workspaces/core';
import { SPOKEN_MAX_WORDS, type SpokenReviewTarget } from '@claude-workspaces/core/spoken-reply';
import type { ReviewItemRow } from '../review-queue.ts';

export const MAX_SPOKEN_OPTIONS = 4;

export type ScreenReason =
  | 'not-an-item'
  | 'card-only'
  | 'something-to-see'
  | 'many-options'
  | 'too-long';

/** One item as the voice queue reads it out and records it. */
export interface WalkItem {
  /** Stable across reads of the queue: the address the answer is written at. */
  key: string;
  target: SpokenReviewTarget;
  /** What it is about — the ticket or the doc. */
  title: string;
  headline: string;
  detail: string;
  options: Array<{ id: string; label: string }>;
  askedBy: string;
}

const IMAGE = /!\[[^\]]*\]\(|https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg)\b/i;
const CODE_BLOCK = /```/;
const PULL_REQUEST = /github\.com\/[^\s/]+\/[^\s/]+\/(?:pull|commit|compare)\//i;
/** The mock route's own spelling (`/mockup/<id>`, with or without the board
 *  prefix) and a diff's, which `parseWorkspaceLink` does not classify. */
const MOCK_OR_DIFF_PATH = /\/(?:mockups?|diffs?)\/[^\s)]/i;

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

export function targetKey(t: SpokenReviewTarget): string {
  return t.kind === 'task-review'
    ? `task|${t.taskId}|${t.reviewItemId}`
    : `doc|${t.docId}|${t.threadId}|${t.commentId}`;
}

/** Why this row needs the screen, or null when it can be decided by voice. */
export function screenReason(row: ReviewItemRow): ScreenReason | null {
  const review = row.review;
  if (!review) return 'not-an-item';
  if (review.shape === 'secret' || review.shape === 'grant') return 'card-only';
  if (row.kind === 'doc-thread' && (row.docType === 'mockup' || row.docType === 'diff')) {
    return 'something-to-see';
  }
  const detail = review.detail ?? '';
  if ([IMAGE, CODE_BLOCK, PULL_REQUEST, MOCK_OR_DIFF_PATH].some((p) => p.test(detail))) {
    return 'something-to-see';
  }
  if (
    extractWorkspaceLinks(detail).some((l) => l.link.kind === 'mockup' || l.link.kind === 'review')
  ) {
    return 'something-to-see';
  }
  const options = review.options ?? [];
  if (options.length > MAX_SPOKEN_OPTIONS) return 'many-options';
  const statement = words(review.headline) + options.reduce((n, o) => n + words(o.label), 0);
  if (statement > SPOKEN_MAX_WORDS) return 'too-long';
  return null;
}

/** The row as the voice queue holds it, or null when it needs the screen. */
export function walkItemOf(row: ReviewItemRow): WalkItem | null {
  if (screenReason(row) !== null || !row.review) return null;
  const target: SpokenReviewTarget | null =
    row.kind === 'task-review'
      ? { kind: 'task-review', taskId: row.taskId, reviewItemId: row.reviewItemId }
      : { kind: 'doc-thread', docId: row.docId, threadId: row.threadId, commentId: row.commentId };
  return {
    key: targetKey(target),
    target,
    title: row.title,
    headline: row.review.headline,
    detail: row.review.detail ?? '',
    options: (row.review.options ?? []).map((o) => ({ id: o.id, label: o.label })),
    askedBy: row.askedBy,
  };
}

/** The queue split in two: what can be read out, and how many need the screen. */
export function splitQueue(rows: readonly ReviewItemRow[]): { items: WalkItem[]; screen: number } {
  const items: WalkItem[] = [];
  let screen = 0;
  for (const row of rows) {
    const item = walkItemOf(row);
    if (item) items.push(item);
    else screen++;
  }
  return { items, screen };
}
