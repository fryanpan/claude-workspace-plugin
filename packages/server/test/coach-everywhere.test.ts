/**
 * One open moment, on every page he has open: a board (one the coach is off
 * for included), a doc and the front page all show it the moment it is
 * raised, and his answer in any one of them clears it in all of them. A page
 * that was away when he answered learns it on reconnecting. A thumbs down
 * carries what he wrote to the coach session.
 *
 * The real moment loop and the real stream hub, wired as `coach/wiring.ts`
 * wires them, with an injected clock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGoalsDoc } from '../src/coach/goals-doc.ts';
import { CoachHub } from '../src/coach/hub.ts';
import { createCoach } from '../src/coach/moment.ts';
import type { SessionNews } from '../src/coach/session-feed.ts';
import { CoachStore } from '../src/coach/store.ts';
import { CoachStream } from '../src/coach/stream.ts';
import { GOALS_DOC, WS, ZONE, at, label } from './coach-fixtures.ts';
import { waitFor } from './wait-for.ts';

const MOMENT = {
  goal: 1,
  matched: 'more than twenty minutes on styling or polish',
  observed: 'Half an hour on the button hover mock',
  line: 'Hi, I’m noticing half an hour on hover states, with the launch post unfinished. Back to the post?',
};
const SHARED = 'w-riverbend';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-everywhere-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function reader(res: Response) {
  const r = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let text = '';
  void (async () => {
    for (;;) {
      const { value, done } = await r.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      text += dec.decode(value);
    }
  })();
  /** Each `coach` frame the page was sent, in order. */
  const frames = () =>
    text
      .split('\n\n')
      .filter((b) => b.startsWith('event: coach\n'))
      .map((b) => JSON.parse(b.slice(b.indexOf('data: ') + 6)) as Record<string, unknown>);
  return { frames };
}

function harness() {
  const clock = at(9);
  const store = new CoachStore(dir, clock);
  store.noteTimeZone(ZONE);
  const told: SessionNews[] = [];
  // A board shared with someone else: the coach hears nothing from it.
  const isOff = (p: { workspaceId: string }) => p.workspaceId === SHARED;
  const hub = new CoachHub({ offAt: isOff });
  const coach = createCoach({
    store,
    stream: new CoachStream(),
    readGoals: () => readGoalsDoc(GOALS_DOC),
    label,
    boardName: () => 'Harborlight',
    workspaceOf: () => WS,
    isOff,
    tell: (news) => {
      told.push(news);
      return true;
    },
    publish: (f) => hub.publish(f),
    reshow: (f) => hub.reshow(f),
    now: () => clock,
  });
  const page = (place: { workspaceId: string; docId?: string } | null) =>
    reader(hub.open(coach.openFrame(), place));
  return { coach, hub, told, page };
}

describe('the open moment on every page', () => {
  it('reaches a board the coach is off for, a doc and the front page at once, and an answer in one clears all three', async () => {
    const h = harness();
    const board = h.page({ workspaceId: SHARED });
    const doc = h.page({ workspaceId: WS, docId: 'd-post' });
    const front = h.page(null);
    const raised = h.coach.raise(MOMENT);
    expect(raised).toMatchObject({ ok: true });
    const id = raised.ok ? raised.id : '';
    for (const p of [board, doc, front]) {
      await waitFor(() => p.frames().some((f) => f.type === 'moment'));
    }
    expect(board.frames().at(-1)).toMatchObject({ type: 'moment', moment: { id }, off: true });
    expect(doc.frames().at(-1)).toMatchObject({ type: 'moment', moment: { id } });
    expect(doc.frames().at(-1)?.off).toBeUndefined();
    expect(front.frames().at(-1)).toMatchObject({ type: 'moment', moment: { id } });

    expect(h.coach.answer(id, 'up')).toBe(true);
    for (const p of [board, doc, front]) {
      await waitFor(() => p.frames().at(-1)?.type === 'clear');
      expect(p.frames().at(-1)).toEqual({ type: 'clear', id });
    }
    h.hub.close();
  });

  it('a page that opens after the answer is told nothing is open, so a card it held goes', async () => {
    const h = harness();
    const raised = h.coach.raise(MOMENT);
    const opened = h.page({ workspaceId: WS });
    await waitFor(() => opened.frames().length === 1);
    expect(opened.frames()[0]).toMatchObject({ type: 'moment' });
    h.coach.answer(raised.ok ? raised.id : '', 'up');
    const later = h.page({ workspaceId: WS });
    await waitFor(() => later.frames().length === 1);
    expect(later.frames()).toEqual([{ type: 'idle' }]);
    h.hub.close();
  });
});

describe('a thumbs down', () => {
  it('carries what he wrote to the coach session, and is kept with the moment', () => {
    const h = harness();
    const raised = h.coach.raise(MOMENT);
    const id = raised.ok ? raised.id : '';
    expect(h.coach.answer(id, 'down', 'I was checking the hover for Alice, not polishing.')).toBe(
      true,
    );
    expect(h.told.filter((n) => n.event === 'coach.answer')).toEqual([
      {
        event: 'coach.answer',
        momentId: id,
        answer: 'down',
        text: 'I was checking the hover for Alice, not polishing.',
        goal: 'Do the hard, important work before the easy polish.',
        line: MOMENT.line,
      },
    ]);
    h.hub.close();
  });
});
