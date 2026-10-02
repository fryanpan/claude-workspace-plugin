/**
 * Which review items the voice queue reads out, and which it leaves for the
 * screen. Each reason is tested beside a row one step away from it that
 * still reads out, so the rule is pinned from both sides.
 */
import { describe, expect, it } from 'bun:test';
import type { ReviewPayload } from '@claude-workspaces/core';
import type { ReviewTaskItem, ReviewThreadItem } from '../src/review-queue.ts';
import {
  MAX_SPOKEN_OPTIONS,
  screenReason,
  splitQueue,
  walkItemOf,
} from '../src/spoken-reply/review-speakable.ts';

function ticket(review: Partial<ReviewPayload>): ReviewTaskItem {
  return {
    kind: 'task-review',
    band: 'declared',
    taskId: 't-1',
    reviewItemId: 'r-1',
    review: { shape: 'decision', headline: 'Ship the Harborlight importer?', ...review },
    title: 'Harborlight importer',
    ask: 'Ship the Harborlight importer?',
    askedBy: 'Riverbend',
    since: 1,
    direct: true,
    askedAt: 1,
    state: 'open',
  };
}

function thread(extra: Partial<ReviewThreadItem>): ReviewThreadItem {
  return {
    kind: 'doc-thread',
    band: 'declared',
    docId: 'd-1',
    threadId: 'th-1',
    commentId: 'c-1',
    title: 'Saltmarsh plan',
    ask: 'Is the plan right?',
    askedBy: 'Riverbend',
    since: 1,
    direct: true,
    review: { shape: 'review', headline: 'Is the plan right?' },
    ...extra,
  };
}

const options = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `o${i}`, label: `Option ${i + 1}` }));

describe('screenReason', () => {
  it('reads out a short decision and a short open question', () => {
    expect(screenReason(ticket({ options: options(2) }))).toBeNull();
    expect(screenReason(thread({}))).toBeNull();
  });

  it('keeps an inferred ask with no declaration for the screen', () => {
    const { review: _none, ...bare } = thread({});
    expect(screenReason({ ...bare, band: 'unreplied' })).toBe('not-an-item');
  });

  it('keeps secrets and grants for their own cards', () => {
    expect(screenReason(ticket({ shape: 'secret' }))).toBe('card-only');
    expect(screenReason(ticket({ shape: 'grant' }))).toBe('card-only');
  });

  it('keeps an item on a mock or a diff for the screen, and reads one on a plain doc', () => {
    expect(screenReason(thread({ docType: 'mockup' }))).toBe('something-to-see');
    expect(screenReason(thread({ docType: 'diff' }))).toBe('something-to-see');
    expect(screenReason(thread({ docType: 'markdown' }))).toBeNull();
  });

  it('keeps an item whose detail shows something, and reads one that only links context', () => {
    const see = [
      'Before and after: ![shot](https://example.com/a.png)',
      'See https://example.com/before.png for the old one.',
      'The change:\n```ts\nconst a = 1;\n```',
      'The PR: https://github.com/example/repo/pull/12',
      'The mock: /workspaces/w-1/mockup/m-1',
      'The mock: [here](/workspaces/w-1/mockups/m-1)',
      'The diff: [review](/workspaces/w-1/attachments/rv-1)',
    ];
    for (const detail of see) {
      expect(screenReason(ticket({ detail, options: options(2) })), detail).toBe(
        'something-to-see',
      );
    }
    const context = [
      'Follows on from [the import task](/workspaces/w-1?task=t-9).',
      'Notes are in [the plan](/workspaces/w-1/docs/d-9).',
    ];
    for (const detail of context) {
      expect(screenReason(ticket({ detail, options: options(2) })), detail).toBeNull();
    }
  });

  it(`reads out up to ${MAX_SPOKEN_OPTIONS} options and keeps more for the screen`, () => {
    expect(screenReason(ticket({ options: options(MAX_SPOKEN_OPTIONS) }))).toBeNull();
    expect(screenReason(ticket({ options: options(MAX_SPOKEN_OPTIONS + 1) }))).toBe('many-options');
  });

  it('keeps an item whose headline and options run past forty words', () => {
    const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
    // 36 headline words + 2 two-word labels = 40: still said.
    expect(screenReason(ticket({ headline: words(36), options: options(2) }))).toBeNull();
    expect(screenReason(ticket({ headline: words(37), options: options(2) }))).toBe('too-long');
  });
});

describe('splitQueue', () => {
  it('holds what reads out, addressed for its answer, and counts the rest', () => {
    const { items, screen } = splitQueue([
      ticket({ options: options(2) }),
      thread({ docType: 'mockup' }),
      thread({}),
    ]);
    expect(screen).toBe(1);
    expect(items.map((i) => i.target)).toEqual([
      { kind: 'task-review', taskId: 't-1', reviewItemId: 'r-1' },
      { kind: 'doc-thread', docId: 'd-1', threadId: 'th-1', commentId: 'c-1' },
    ]);
    expect(walkItemOf(thread({ docType: 'diff' }))).toBeNull();
  });
});
