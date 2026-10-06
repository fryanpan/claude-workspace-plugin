import { describe, expect, it } from 'vitest';
import { type RecentAnswer, ownRecentAnswers, undoTarget } from '../src/board/recent-answers.ts';

const row = (over: Partial<RecentAnswer>): RecentAnswer => ({
  key: 'task-review:t-1:r-1',
  taskId: 't-1',
  reviewItemId: 'r-1',
  headline: 'Export nightly?',
  answer: 'Nightly',
  by: 'Alice',
  ts: 1,
  ...over,
});

describe('ownRecentAnswers', () => {
  it('keeps the reader’s own answers that are not back on the queue', () => {
    const mine = row({});
    const bobs = row({ key: 'task-review:t-1:r-2', by: 'Bob' });
    const reopened = row({ key: 'decision:t-2' });
    expect(ownRecentAnswers([mine, bobs, reopened], 'Alice', new Set(['decision:t-2']))).toEqual([
      mine,
    ]);
  });
});

describe('undoTarget', () => {
  it('addresses a ticket item, and the ticket’s own decision as r-legacy', () => {
    expect(
      undoTarget({ kind: 'task-review', thread: { taskId: 't-1', reviewItemId: 'r-1' } }),
    ).toEqual({ taskId: 't-1', reviewItemId: 'r-1' });
    expect(undoTarget({ kind: 'decision', decision: { task: { id: 't-2' } } })).toEqual({
      taskId: 't-2',
      reviewItemId: 'r-legacy',
    });
  });

  it('has no target for a thread reply', () => {
    expect(undoTarget({ kind: 'task-thread', thread: { taskId: 't-1' } })).toBeUndefined();
  });

  it('has no target for a secret or grant item, whose answer the undo route refuses', () => {
    const thread = { taskId: 't-1', reviewItemId: 'r-1' };
    for (const shape of ['secret', 'grant']) {
      expect(undoTarget({ kind: 'task-review', thread, review: { shape } })).toBeUndefined();
    }
  });
});
