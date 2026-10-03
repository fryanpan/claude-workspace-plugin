/**
 * The coach's loop over a whole day: the drifting day raises one moment that
 * names the goal and what he was doing, the on-track day raises none, and
 * every gate that can decline is checked before a model is asked.
 *
 * The judge here is a stand-in that reads the prompt's "Right now" line and
 * speaks only after twenty minutes on the hover mock, which proves the
 * plumbing and nothing about judgement. `scripts/coach-eval.ts` asks the
 * real model at each labelled point of the same day.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGoalsDoc } from '../src/coach/goals-doc.ts';
import { type CoachFrame, MIN_JUDGE_GAP_MS, createCoach } from '../src/coach/moment.ts';
import { CoachStore } from '../src/coach/store.ts';
import { CoachStream } from '../src/coach/stream.ts';
import {
  DAY_END,
  DAY_START,
  DRIFTING_DAY,
  GOALS_DOC,
  ON_TRACK_DAY,
  type Signal,
  WS,
  ZONE,
  at,
  label,
} from './coach-fixtures.ts';

const HOVER_REPLY = JSON.stringify({
  verdict: 'moment',
  goal: 1,
  matched: 'more than twenty minutes on styling or polish',
  observed: 'Twenty minutes and more on the button hover mock',
  line: 'Hi, I’m noticing you’ve been on hover states a while, with the launch post unfinished. Back to the post?',
});

/** Speaks only after twenty minutes on the hover mock. */
async function standInJudge({ user }: { system: string; user: string }): Promise<string> {
  const now = user.match(/Right now: Since \d\d:\d\d on "([^"]+)".*?: (\d+) min active/);
  if (now?.[1] === 'Button hover states mock' && Number(now[2]) >= 20) return HOVER_REPLY;
  return '{"verdict":"quiet"}';
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-moment-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function harness(opts: { goals?: string | null; generate?: typeof standInJudge | null } = {}) {
  let clock = DAY_START;
  const store = new CoachStore(dir, clock);
  store.noteTimeZone(ZONE);
  const frames: CoachFrame[] = [];
  let calls = 0;
  const goals = opts.goals === undefined ? GOALS_DOC : opts.goals;
  const generate = opts.generate === undefined ? standInJudge : opts.generate;
  const coach = createCoach({
    store,
    stream: new CoachStream(),
    readGoals: () => (goals === null ? null : readGoalsDoc(goals)),
    label,
    boardName: () => 'Harborlight',
    workspaceOf: () => WS,
    generate: generate
      ? async (p) => {
          calls += 1;
          return generate(p);
        }
      : null,
    publish: (f) => frames.push(f),
    now: () => clock,
    log: () => {},
  });
  const play = async (signals: Signal[], until = DAY_END) => {
    for (const s of signals) {
      if (s.at > until) break;
      clock = s.at;
      if ('here' in s) coach.here(s.here);
      else coach.activity(s.row);
      await coach.settled();
    }
    clock = until;
  };
  return { store, coach, frames, play, calls: () => calls, setClock: (t: number) => (clock = t) };
}

describe('a whole day', () => {
  it('the drifting day raises one moment, naming the goal and what he was doing', async () => {
    const h = harness();
    await h.play(DRIFTING_DAY, at(10, 30));
    const moments = h.store.moments();
    expect(moments).toHaveLength(1);
    expect(moments[0]?.goal).toBe('Do the hard, important work before the easy polish.');
    expect(moments[0]?.observed).toBe('Twenty minutes and more on the button hover mock');
    expect(h.frames).toEqual([
      {
        type: 'moment',
        moment: {
          id: moments[0]?.id ?? '',
          at: moments[0]?.at ?? 0,
          name: 'Saltmarsh',
          line: moments[0]?.line ?? '',
          goal: 'Do the hard, important work before the easy polish.',
        },
      },
    ]);
    await h.play(DRIFTING_DAY.filter((s) => s.at > at(10, 30)));
    expect(h.store.moments()).toHaveLength(1);
  });

  it('the on-track day raises none, though it looks', async () => {
    const h = harness();
    await h.play(ON_TRACK_DAY);
    expect(h.store.moments()).toHaveLength(0);
    expect(h.calls()).toBeGreaterThan(0);
    expect(h.store.judgements().every((j) => j.outcome === 'quiet')).toBe(true);
  });

  it('spends at most one call in twenty minutes, and a day in well under thirty', async () => {
    const h = harness();
    await h.play(DRIFTING_DAY);
    const times = h.store.judgements().map((j) => j.at);
    for (let i = 1; i < times.length; i += 1) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(MIN_JUDGE_GAP_MS);
    }
    expect(h.calls()).toBe(times.length);
    expect(h.calls()).toBeLessThan(30);
  });
});

describe('the gates before a model is asked', () => {
  it('no goals doc, or no goal that says when, asks nothing', async () => {
    const none = harness({ goals: null });
    await none.play(DRIFTING_DAY);
    const unready = harness({
      goals: '# Learning goals\n\n## Goal 1\n\n### What I want to do better\n\nShip it\n',
    });
    await unready.play(DRIFTING_DAY);
    expect(none.calls() + unready.calls()).toBe(0);
    expect(none.store.judgements()).toHaveLength(0);
  });

  it('no model records that, once a trigger fires, and raises nothing', async () => {
    const h = harness({ generate: null });
    await h.play(DRIFTING_DAY, at(10, 30));
    expect(h.store.judgements().map((j) => j.outcome)).toContain('no-model');
    expect(h.store.moments()).toHaveLength(0);
  });

  it('an open moment holds the next, and “not now” pushes the next one out', async () => {
    const h = harness({ generate: async () => HOVER_REPLY });
    h.setClock(at(9));
    expect(await h.coach.judgeNow()).toMatchObject({ outcome: 'moment' });
    h.setClock(at(9, 5));
    expect(await h.coach.judgeNow()).toEqual({ skipped: 'moment-open' });
    const id = h.store.moments()[0]?.id ?? '';
    expect(h.coach.answer(id, 'not-now')).toBe(true);
    expect(h.frames.at(-1)).toEqual({ type: 'clear', id });
    h.setClock(at(10, 30));
    expect(await h.coach.judgeNow()).toEqual({ skipped: 'spacing' });
    h.setClock(at(11));
    expect(await h.coach.judgeNow()).toMatchObject({ outcome: 'moment' });
  });

  it('a reply that matches no trigger is quiet', async () => {
    const h = harness({
      generate: async () =>
        JSON.stringify({ ...JSON.parse(HOVER_REPLY), matched: 'working too hard' }),
    });
    h.setClock(at(9));
    expect(await h.coach.judgeNow()).toMatchObject({ outcome: 'unusable-reply' });
    expect(h.store.moments()).toHaveLength(0);
  });

  it('his own edit of the goals doc resets the weekly offer', () => {
    const h = harness();
    h.store.setGoalsDoc({ workspaceId: WS, docId: 'd-goals', createdAt: at(8) - 8 * 86_400_000 });
    expect(h.store.reviewDue(at(9))).toBe(true);
    h.setClock(at(9));
    const edit = DRIFTING_DAY.find((s) => 'row' in s && s.row.type === 'edit_session');
    if (!edit || !('row' in edit)) throw new Error('the drifting day has an edit');
    h.coach.activity({
      ...edit.row,
      doc: { ...edit.row.doc, docId: 'd-goals' } as NonNullable<typeof edit.row.doc>,
    });
    expect(h.store.reviewDue(at(9, 1))).toBe(false);
  });
});
