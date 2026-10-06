import { describe, expect, it } from 'bun:test';
import type { TaskReviewItem } from '@claude-workspaces/core';
import type { Task } from '@claude-workspaces/core/task-wire';
import {
  RECENT_ANSWER_WINDOW_MS,
  mayChangeAnswer,
  recentTicketAnswers,
  replacedDecisionAnswer,
  replacedItemAnswer,
} from '../src/review-items/answer-change.ts';

const item = (extra: Partial<TaskReviewItem> = {}): TaskReviewItem => ({
  id: 'r-1',
  review: { shape: 'decision', headline: 'Export nightly?' },
  createdAt: 1,
  createdBy: 'Riverbend',
  ...extra,
});

describe('who may change an answer', () => {
  it('the answerer, or anyone when nothing stands', () => {
    expect(mayChangeAnswer({ by: 'Alice' }, { name: 'Alice' })).toBe(true);
    expect(mayChangeAnswer({ by: 'Alice' }, { name: 'Bob' })).toBe(false);
    expect(mayChangeAnswer(undefined, { name: 'Bob' })).toBe(true);
  });
});

describe('the answer a new one replaces', () => {
  it('is the standing answer', () => {
    const r = item({ answer: { text: 'Nightly', by: 'Alice', ts: 10, answeredWith: 'o-y' } });
    expect(replacedItemAnswer(r)).toEqual({
      answer: 'Nightly',
      optionId: 'o-y',
      by: 'Alice',
      ts: 10,
    });
  });

  it('is the one taken back after an undo', () => {
    const r = item({ priorAnswers: [{ text: 'Nightly', by: 'Alice', ts: 10 }] });
    expect(replacedItemAnswer(r)?.answer).toBe('Nightly');
  });

  it('is nothing on a first answer, or once the question was revised after the undo', () => {
    expect(replacedItemAnswer(item())).toBeUndefined();
    const revised = item({
      priorAnswers: [{ text: 'Nightly', by: 'Alice', ts: 10 }],
      revisions: [{ at: 20, by: 'Riverbend', headline: 'Export at all?' }],
    });
    expect(replacedItemAnswer(revised)).toBeUndefined();
  });

  it('reads the ticket decision’s undo history the same way', () => {
    const base = {
      answerHistory: [{ text: 'Ship', by: 'Alice', ts: 5, withdrawnAt: 9, withdrawnBy: 'Alice' }],
    };
    expect(replacedDecisionAnswer(base as unknown as Task)?.answer).toBe('Ship');
    const revised = {
      ...base,
      decisionRevisions: [{ at: 12, by: 'Riverbend', headline: 'Ship?' }],
    };
    expect(replacedDecisionAnswer(revised as unknown as Task)).toBeUndefined();
  });
});

describe('recent answers', () => {
  it('lists the last day’s answers newest first, keyed as the queue keys them', () => {
    const now = 10 * RECENT_ANSWER_WINDOW_MS;
    const rows = recentTicketAnswers(
      [
        {
          id: 't-1',
          reviews: [
            item({
              id: 'r-old',
              answer: { text: 'A', by: 'Alice', ts: now - RECENT_ANSWER_WINDOW_MS - 1 },
            }),
            item({ id: 'r-new', answer: { text: 'B', by: 'Alice', ts: now - 5 } }),
            item({ id: 'r-legacy', answer: { text: 'C', by: 'Alice', ts: now - 1 } }),
            item({ id: 'r-open' }),
            item({
              id: 'r-secret',
              answer: { text: 'saved', by: 'Alice', ts: now - 1 },
              review: { shape: 'secret', headline: 'Signing value' },
            }),
            item({
              id: 'r-grant',
              answer: { text: 'approved', by: 'Alice', ts: now - 1 },
              review: { shape: 'grant', headline: 'Allow push' },
            }),
            item({
              id: 'r-gone',
              answer: { text: 'D', by: 'Alice', ts: now - 1 },
              review: { shape: 'decision', headline: 'x', withdrawnAt: now - 1 },
            }),
          ],
        },
      ],
      now,
    );
    expect(rows.map((r) => r.key)).toEqual(['decision:t-1', 'task-review:t-1:r-new']);
  });
});
