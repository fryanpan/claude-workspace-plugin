/**
 * A window of the owner's events as the coach session reads it: a run of
 * views in one place is that place and the minutes he spent there, and what
 * he wrote, commented and replied keeps its words.
 */
import { describe, expect, it } from 'bun:test';
import { type DigestEvent, digestOf } from '../src/coach/digest.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 7, 16, 0);

const view = (min: number, docId: string, heading?: string): DigestEvent => ({
  at: T0 + min * MIN,
  kind: 'view',
  boardId: 'w-harbor',
  board: 'Harborlight',
  docId,
  doc: docId === 'd-post' ? 'Harborlight launch post' : 'Button hover mock',
  ...(heading ? { heading } : {}),
  text: 'A passage of 600 characters the digest does not need.',
});

describe('digestOf', () => {
  it('collapses a run of views in one place into that place and its minutes', () => {
    const events = Array.from({ length: 20 }, (_, i) => view(i * 0.5, 'd-hover', `Part ${i % 3}`));
    expect(digestOf(events, T0 + 15 * MIN)).toEqual([
      {
        kind: 'view',
        at: T0,
        minutes: 15,
        boardId: 'w-harbor',
        board: 'Harborlight',
        docId: 'd-hover',
        doc: 'Button hover mock',
        headings: ['Part 0', 'Part 1', 'Part 2'],
      },
    ]);
  });

  it('ends a stay when he goes elsewhere or the tab goes hidden', () => {
    const items = digestOf(
      [
        view(0, 'd-post'),
        view(4, 'd-hover'),
        { at: T0 + 10 * MIN, kind: 'left', boardId: 'w-harbor', docId: 'd-hover' },
      ],
      T0 + 15 * MIN,
    );
    expect(items.map((i) => [i.kind, i.docId, i.kind === 'view' ? i.minutes : null])).toEqual([
      ['view', 'd-post', 4],
      ['view', 'd-hover', 6],
      ['left', 'd-hover', null],
    ]);
  });

  it('keeps every wrote, comment and reply with its text, and a stay goes on past them', () => {
    const items = digestOf(
      [
        view(0, 'd-post'),
        {
          at: T0 + 2 * MIN,
          kind: 'wrote',
          boardId: 'w-harbor',
          docId: 'd-post',
          heading: 'Pricing',
          text: 'The first berth is free.',
        },
        { at: T0 + 3 * MIN, kind: 'comment', boardId: 'w-harbor', docId: 'd-post', text: 'Alice?' },
        view(5, 'd-post', 'Pricing'),
        { at: T0 + 6 * MIN, kind: 'reply', boardId: 'w-harbor', docId: 'd-post', text: 'Yes.' },
      ],
      T0 + 9 * MIN,
    );
    expect(items).toEqual([
      expect.objectContaining({ kind: 'view', docId: 'd-post', minutes: 9, headings: ['Pricing'] }),
      expect.objectContaining({
        kind: 'wrote',
        heading: 'Pricing',
        text: 'The first berth is free.',
      }),
      expect.objectContaining({ kind: 'comment', text: 'Alice?' }),
      expect.objectContaining({ kind: 'reply', text: 'Yes.' }),
    ]);
    expect(items[0]).not.toHaveProperty('text');
  });
});
