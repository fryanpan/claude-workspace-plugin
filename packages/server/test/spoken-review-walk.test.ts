/**
 * The review queue by voice, through the spoken answerer: every decision is
 * read back before anything is recorded, "no" or "wait" at the read-back
 * records nothing, and "no", "wait" or "undo that" right after a recording
 * sends its undo.
 *
 * "Recorded" here means the answerer handed the page a `decide` to write —
 * the only way the walk writes anything. The route test
 * (`spoken-review-route.test.ts`) follows those writes into the store.
 */
import { describe, expect, it } from 'bun:test';
import type { ReviewPayload } from '@claude-workspaces/core';
import type { ReviewItemRow, ReviewTaskItem, ReviewThreadItem } from '../src/review-queue.ts';
import { type SpokenAnswer, SpokenAnswerer, type SpokenBoard } from '../src/spoken-reply/answer.ts';

const ACTOR = { id: 'known-alice', name: 'Alice', kind: 'known' };

function ticketRow(id: string, review: Partial<ReviewPayload>): ReviewTaskItem {
  return {
    kind: 'task-review',
    band: 'declared',
    taskId: `t-${id}`,
    reviewItemId: `r-${id}`,
    review: { shape: 'decision', headline: `Headline ${id}`, ...review },
    title: `Ticket ${id}`,
    ask: review.headline ?? `Headline ${id}`,
    askedBy: 'Riverbend',
    since: 1,
    direct: true,
    askedAt: 1,
    state: 'open',
  };
}

function threadRow(id: string, extra: Partial<ReviewThreadItem>): ReviewThreadItem {
  return {
    kind: 'doc-thread',
    band: 'declared',
    docId: `doc-${id}`,
    threadId: `th-${id}`,
    commentId: `c-${id}`,
    title: `Doc ${id}`,
    ask: `Ask ${id}`,
    askedBy: 'Saltmarsh',
    since: 1,
    direct: true,
    ...extra,
  };
}

const MOCK_ITEM = ticketRow('mock', {
  shape: 'review',
  headline: 'Approve the mock?',
  options: [
    { id: 'o-approve', label: 'Approve' },
    { id: 'o-rework', label: 'Rework' },
  ],
});
const NAME_ITEM = ticketRow('name', {
  headline: 'Pick a name for the importer',
  detail: 'The importer moves Harborlight boards. Short names read better in the menu.',
  options: [
    { id: 'o-dock', label: 'Dock' },
    { id: 'o-ferry', label: 'Ferry' },
  ],
});
const OPEN_ITEM = threadRow('open', {
  review: { shape: 'review', headline: 'Is the copy on the empty state right?' },
});
/** Needs the screen: it hangs on a mock. */
const SCREEN_ITEM = threadRow('screen', {
  docType: 'mockup',
  review: {
    shape: 'decision',
    headline: 'Which layout?',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
  },
});

function harness(rows: ReviewItemRow[], explain?: SpokenBoard['explain']) {
  const live = [...rows];
  const routed: string[] = [];
  const b: SpokenBoard = {
    async handle(_ws, req) {
      routed.push(req.transcript);
      return { ok: true, route: 'fast-path', ack: 'Routed.' };
    },
    goalStatus: () => undefined,
    goals: () => [],
    reviewQueue: () => live,
    ...(explain ? { explain } : {}),
  };
  const answerer = new SpokenAnswerer(b, 'w-1');
  const decides: NonNullable<SpokenAnswer['decide']>[] = [];
  const say = async (text: string): Promise<SpokenAnswer> => {
    const a = await answerer.answer(text, ACTOR, undefined);
    if (a.decide) decides.push(a.decide);
    return a;
  };
  return { answerer, say, decides, routed, live };
}

describe('starting the queue', () => {
  it('counts what it can read, counts what needs the screen, and reads the first item', async () => {
    const h = harness([MOCK_ITEM, SCREEN_ITEM, NAME_ITEM]);
    const a = await h.say('Claude, go through my reviews');
    expect(a.route).toBe('review-queue');
    expect(a.spoken).toBe(
      'Two to go through, and one needs the screen. First: Approve the mock? Approve or Rework?',
    );
    expect(a.asking).toBe(true);
    expect(a.choices).toEqual(['Approve', 'Rework']);
    expect(h.routed).toEqual([]);
  });

  it('says so when nothing can be read out', async () => {
    const h = harness([SCREEN_ITEM]);
    expect((await h.say('go through my reviews')).spoken).toBe(
      'Nothing I can read out: one needs the screen.',
    );
    // No walk is running, so the next thing said goes to the router.
    await h.say('how is the board');
    expect(h.routed).toEqual(['how is the board']);
  });
});

describe('nothing is recorded until a yes', () => {
  it('reads a pick back and records it only on the yes', async () => {
    const h = harness([MOCK_ITEM, NAME_ITEM]);
    await h.say('go through my reviews');
    const back = await h.say('approve the mock');
    expect(back.spoken).toBe('Recording: Approve. OK?');
    expect(back.decide).toBeUndefined();
    expect(h.decides).toEqual([]);
    const yes = await h.say('yes');
    expect(h.decides).toEqual([
      {
        id: 'd1',
        action: 'record',
        target: { kind: 'task-review', taskId: 't-mock', reviewItemId: 'r-mock' },
        text: 'Approve',
        optionId: 'o-approve',
      },
    ]);
    expect(yes.spoken).toBe('Recorded. Next: Pick a name for the importer. Dock or Ferry?');
  });

  it('records free words verbatim on an item with no options, after the read-back', async () => {
    const h = harness([OPEN_ITEM]);
    await h.say('go through my reviews');
    expect((await h.say('Looks right, ship it')).spoken).toBe(
      'Recording: Looks right, ship it. OK?',
    );
    expect(h.decides).toEqual([]);
    await h.say('okay');
    expect(h.decides[0]).toEqual({
      id: 'd1',
      action: 'record',
      target: { kind: 'doc-thread', docId: 'doc-open', threadId: 'th-open', commentId: 'c-open' },
      text: 'Looks right, ship it',
    });
  });

  for (const word of ['no', 'wait', 'No, wait.']) {
    it(`"${word}" at the read-back records nothing and asks again`, async () => {
      const h = harness([MOCK_ITEM]);
      await h.say('go through my reviews');
      await h.say('the second one');
      const again = await h.say(word);
      expect(again.spoken).toBe('Not recorded. Approve the mock? Approve or Rework?');
      expect(h.decides).toEqual([]);
      // The walk is back on the item, not past it: a fresh pick reads back.
      expect((await h.say('first')).spoken).toBe('Recording: Approve. OK?');
      expect(h.decides).toEqual([]);
    });
  }

  it('reads back a different pick said after a no', async () => {
    const h = harness([MOCK_ITEM]);
    await h.say('go through my reviews');
    await h.say('approve');
    expect((await h.say('no, rework')).spoken).toBe('Recording: Rework. OK?');
    expect(h.decides).toEqual([]);
  });

  it('asks for a yes or a no rather than reading anything else as a yes', async () => {
    const h = harness([MOCK_ITEM]);
    await h.say('go through my reviews');
    await h.say('approve');
    expect((await h.say('maybe')).spoken).toBe('Say yes to record Approve, or no.');
    expect(h.decides).toEqual([]);
  });
});

describe('undo just after recording', () => {
  for (const word of ['no', 'wait', 'undo that']) {
    it(`"${word}" sends the undo and goes back to that item`, async () => {
      const h = harness([MOCK_ITEM, NAME_ITEM]);
      await h.say('go through my reviews');
      await h.say('approve');
      await h.say('yes');
      const back = await h.say(word);
      expect(h.decides.map((d) => d.action)).toEqual(['record', 'undo']);
      expect(h.decides[1]).toEqual({
        id: 'd2',
        action: 'undo',
        target: { kind: 'task-review', taskId: 't-mock', reviewItemId: 'r-mock' },
      });
      expect(back.spoken).toBe(
        'Taken back, so nothing is recorded. Approve the mock? Approve or Rework?',
      );
    });
  }

  it('undoes the last item even after the walk has finished', async () => {
    const h = harness([MOCK_ITEM]);
    await h.say('go through my reviews');
    await h.say('rework');
    expect((await h.say('yes')).spoken).toBe('Recorded. That’s all I can read out.');
    await h.say('undo that');
    expect(h.decides.map((d) => d.action)).toEqual(['record', 'undo']);
  });

  it('holds the window for one utterance only', async () => {
    const h = harness([MOCK_ITEM, NAME_ITEM]);
    await h.say('go through my reviews');
    await h.say('approve');
    await h.say('yes');
    await h.say('what is the importer for');
    await h.say('undo that');
    expect(h.decides.map((d) => d.action)).toEqual(['record']);
  });
});

describe('the rest of the walk', () => {
  it('answers a question about the item from its detail and records nothing', async () => {
    const h = harness([NAME_ITEM]);
    await h.say('go through my reviews');
    const a = await h.say('what does the importer do');
    expect(a.spoken).toBe(
      'The importer moves Harborlight boards. Short names read better in the menu. Dock or Ferry?',
    );
    expect(h.decides).toEqual([]);
  });

  it('asks the model when it has one, with the item and the question', async () => {
    const calls: string[] = [];
    const h = harness([NAME_ITEM], async ({ user }) => {
      calls.push(user);
      return 'It moves boards between servers.';
    });
    await h.say('go through my reviews');
    expect((await h.say('why does it need a name?')).spoken).toBe(
      'It moves boards between servers. Dock or Ferry?',
    );
    expect(calls[0]).toContain('Item: Pick a name for the importer');
    expect(calls[0]).toContain('Question: why does it need a name?');
  });

  it('skips, leaving the item unanswered, and stops on request', async () => {
    const h = harness([MOCK_ITEM, NAME_ITEM]);
    await h.say('go through my reviews');
    expect((await h.say('skip')).spoken).toBe(
      'Left on your queue. Next: Pick a name for the importer. Dock or Ferry?',
    );
    expect((await h.say('stop')).spoken).toBe('Stopped, with one still to go.');
    expect(h.decides).toEqual([]);
  });

  it('passes over an item answered on the screen meanwhile', async () => {
    const h = harness([MOCK_ITEM, NAME_ITEM, OPEN_ITEM]);
    await h.say('go through my reviews');
    h.live.splice(h.live.indexOf(NAME_ITEM), 1);
    expect((await h.say('skip')).spoken).toBe(
      'Left on your queue. Next: Is the copy on the empty state right? What’s your answer?',
    );
  });

  it('says a failed write aloud, and a later undo has nothing to take back', async () => {
    const h = harness([MOCK_ITEM, NAME_ITEM]);
    await h.say('go through my reviews');
    await h.say('approve');
    await h.say('yes');
    expect(h.answerer.decided('d1', true)).toBeNull();
    await h.say('dock');
    await h.say('yes');
    const failed = h.answerer.decided('d2', false);
    expect(failed?.spoken).toBe(
      'That one didn’t go through, so “Pick a name for the importer” is still on your queue.',
    );
    await h.say('undo that');
    expect(h.decides.map((d) => d.action)).toEqual(['record', 'record']);
  });
});
