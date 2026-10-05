/**
 * The plan lead's rank on single review items: Home's queue puts ranked items
 * first, lowest rank first, and keeps every unranked item in exactly the
 * order it had. A task's asks keep their filing order, and a person moving
 * the task voids a rank set before the move.
 *
 * Fixtures are invented; the repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewPayload } from '@claude-workspaces/core';
import {
  type BoardQueueInput,
  type CrossReviewItem,
  applyLeadRanks,
  crossReviewQueue,
} from '../src/cross-review-queue.ts';
import type { RankedProject } from '../src/review-plan.ts';
import { MAX_RANK, ReviewRanks, parseRank } from '../src/review-ranks.ts';
import type { SizedReviewItemRow } from '../src/review-sizing.ts';

const REVIEW: ReviewPayload = { shape: 'review', headline: 'Look at this' };

const taskItem = (taskId: string, rid: string, since: number): SizedReviewItemRow => ({
  kind: 'task-review',
  band: 'declared',
  taskId,
  reviewItemId: rid,
  review: REVIEW,
  title: taskId,
  ask: REVIEW.headline,
  askedBy: 'Riverbend Agent',
  since,
  direct: true,
  askedAt: since,
  state: 'open',
  minutes: 1,
  size: 'easy',
});

const docItem = (docId: string, threadId: string, since: number): SizedReviewItemRow => ({
  kind: 'doc-thread',
  band: 'declared',
  docId,
  threadId,
  commentId: `c-${threadId}`,
  title: docId,
  ask: 'Does this read right?',
  askedBy: 'Harborlight Agent',
  since,
  direct: true,
  minutes: 1,
  size: 'easy',
});

const project = (workspaceId: string, rank: number): RankedProject => ({
  workspaceId,
  name: workspaceId,
  lastActivity: 0,
  rank,
  planned: true,
});

/** Two boards: Harborlight first, with two tasks (two asks on the first), then Riverbend. */
function boards(): BoardQueueInput[] {
  return [
    {
      project: project('w-harbor', 1),
      rows: [taskItem('t-a', 'r-1', 10), taskItem('t-a', 'r-2', 20), taskItem('t-b', 'r-1', 30)],
      tasks: [
        { id: 't-a', goal: 'g-1', order: 0, createdAt: 1 },
        { id: 't-b', goal: 'g-1', order: 1, createdAt: 2 },
      ],
      goalIds: ['g-1'],
    },
    {
      project: project('w-river', 2),
      rows: [docItem('d-ferry', 'th-1', 5), taskItem('t-c', 'r-1', 40)],
      tasks: [{ id: 't-c', goal: 'g-1', order: 0, createdAt: 3 }],
      goalIds: ['g-1'],
    },
  ];
}

const keys = (items: CrossReviewItem[]) => items.map((i) => i.key);

const TODAY = [
  'w-harbor:task-review:t-a:r-1',
  'w-harbor:task-review:t-a:r-2',
  'w-harbor:task-review:t-b:r-1',
  'w-river:task-review:t-c:r-1',
  'w-river:doc-thread:d-ferry:th-1',
];

describe('applyLeadRanks', () => {
  const items = () => crossReviewQueue(boards()).items;

  it('leaves today’s order exactly when nothing is ranked', () => {
    expect(keys(items())).toEqual(TODAY);
    expect(keys(applyLeadRanks(items(), () => undefined))).toEqual(TODAY);
  });

  it('puts ranked items first by rank, and the rest in today’s order', () => {
    const rank = new Map([
      ['w-river:doc-thread:d-ferry:th-1', 1],
      ['w-river:task-review:t-c:r-1', 2],
    ]);
    expect(keys(applyLeadRanks(items(), (i) => rank.get(i.key)))).toEqual([
      'w-river:doc-thread:d-ferry:th-1',
      'w-river:task-review:t-c:r-1',
      'w-harbor:task-review:t-a:r-1',
      'w-harbor:task-review:t-a:r-2',
      'w-harbor:task-review:t-b:r-1',
    ]);
  });

  it('brings a task’s earlier ask along ahead of a ranked later one', () => {
    const [harbor] = boards();
    if (!harbor) throw new Error('fixture');
    // t-a is placed after t-b, so today t-b's ask comes first.
    harbor.tasks = [
      { id: 't-a', goal: 'g-1', order: 1, createdAt: 1 },
      { id: 't-b', goal: 'g-1', order: 0, createdAt: 2 },
    ];
    const q = crossReviewQueue([harbor]).items;
    expect(keys(q)).toEqual([
      'w-harbor:task-review:t-b:r-1',
      'w-harbor:task-review:t-a:r-1',
      'w-harbor:task-review:t-a:r-2',
    ]);
    const rank = new Map([['w-harbor:task-review:t-a:r-2', 1]]);
    expect(keys(applyLeadRanks(q, (i) => rank.get(i.key)))).toEqual([
      'w-harbor:task-review:t-a:r-1',
      'w-harbor:task-review:t-a:r-2',
      'w-harbor:task-review:t-b:r-1',
    ]);
  });
});

describe('ReviewRanks', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps ranks across a restart, and a person’s later move voids one', () => {
    dir = mkdtempSync(join(tmpdir(), 'review-ranks-'));
    let now = 1_000;
    const ranks = new ReviewRanks(dir, () => now);
    ranks.set('w-harbor:task-review:t-a:r-1', 3, 'agent-team-lead');
    ranks.set('w-river:doc-thread:d-ferry:th-1', 1, 'agent-team-lead');
    expect(ranks.rankOf('w-harbor:task-review:t-a:r-1', 'w-harbor', 't-a')).toBe(3);

    // A person moves the task after the rank: the rank no longer counts.
    ranks.notePersonMove('w-harbor', 't-a', 2_000);
    const reread = new ReviewRanks(dir, () => now);
    expect(reread.rankOf('w-harbor:task-review:t-a:r-1', 'w-harbor', 't-a')).toBeUndefined();
    expect(reread.get('w-harbor:task-review:t-a:r-1')?.rank).toBe(3);
    expect(reread.rankOf('w-river:doc-thread:d-ferry:th-1', 'w-river')).toBe(1);

    // A rank set after the move was made knowing it, and counts.
    now = 3_000;
    reread.set('w-harbor:task-review:t-a:r-1', 2, 'agent-team-lead');
    expect(reread.rankOf('w-harbor:task-review:t-a:r-1', 'w-harbor', 't-a')).toBe(2);

    reread.set('w-river:doc-thread:d-ferry:th-1', null, 'agent-team-lead');
    expect(reread.rankOf('w-river:doc-thread:d-ferry:th-1', 'w-river')).toBeUndefined();
  });

  it('accepts a whole rank from 1 to the maximum, or null, and nothing else', () => {
    expect(parseRank(1)).toBe(1);
    expect(parseRank(MAX_RANK)).toBe(MAX_RANK);
    expect(parseRank(null)).toBeNull();
    for (const bad of [0, -1, 1.5, MAX_RANK + 1, '1', undefined, Number.NaN]) {
      expect(parseRank(bad)).toBeUndefined();
    }
  });
});
