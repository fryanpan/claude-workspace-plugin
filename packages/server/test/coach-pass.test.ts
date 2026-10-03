/**
 * The coach's check, driven through two fixture weeks on a fake clock.
 *
 * The model is replaced by a scorer that reads the PROMPT the check built:
 * it sums the minutes on lines whose title shares a word with a goal, and
 * calls drift when the rest outweigh them two to one. So a pass here proves
 * the prompt carries the goals, the owner's own rows and their times, and
 * that the gates, the store and the section turn one verdict into exactly
 * one line on the page. Whether the real model judges these weeks the same
 * way is `scripts/coach-eval.ts`, which runs them through Haiku.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coachSectionFor } from '../src/coach/landing.ts';
import { type CoachGenerator, TICK_MS, createCoach } from '../src/coach/pass.ts';
import { CoachStore } from '../src/coach/store.ts';
import {
  DRIFTING_WEEK,
  GOALS,
  ON_TRACK_WEEK,
  WEEK_END,
  WEEK_START,
  ZONE,
  at,
} from './coach-fixtures.ts';

const STOP = new Set(['the', 'to', 'and', 'of', 'a', 'flow']);
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 3 && !STOP.has(w));

/** A stand-in judge that reads only the prompt it is handed. */
function scorer(calls: string[]): CoachGenerator {
  return async ({ user }) => {
    calls.push(user);
    const goals = [...user.matchAll(/^(\d)\. (.+)$/gm)].map((m) => words(m[2] ?? ''));
    let on = 0;
    let off = 0;
    const offTitles: string[] = [];
    for (const m of user.matchAll(/^\d\d:\d\d–\d\d:\d\d \w+ "([^"]+)".*?read (\d+) min/gm)) {
      const title = m[1] ?? '';
      const minutes = Number(m[2]);
      if (goals.some((g) => g.some((w) => words(title).includes(w)))) on += minutes;
      else {
        off += minutes;
        offTitles.push(title);
      }
    }
    if (off < 60 || off < 2 * on) return '{"verdict":"on-track"}';
    return JSON.stringify({
      verdict: 'drift',
      goal: 1,
      drift: `Most of today went to ${offTitles.slice(0, 2).join(' and ')}`,
      question: 'Is publishing the launch post still first this week?',
    });
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-pass-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the loop across the week, every tick, with rows appearing as they
 *  happen. Returns the store, every prompt the judge saw, and the section
 *  as the front page drew it on Wednesday evening. */
async function runWeek(rows: readonly { ts: string }[]) {
  let clock = WEEK_START;
  const store = new CoachStore(dir, clock);
  store.setGoals(GOALS, ZONE, at(0, 8));
  const calls: string[] = [];
  const coach = createCoach({
    store,
    readRows: () => rows.filter((r) => Date.parse(r.ts) <= clock),
    label: () => ({}),
    generate: scorer(calls),
    now: () => clock,
    log: () => {},
  });
  let wednesdayEvening = '';
  for (clock = WEEK_START; clock < WEEK_END; clock += TICK_MS) {
    await coach.tick();
    if (clock === at(2, 20)) wednesdayEvening = coachSectionFor(store, clock);
  }
  return { store, calls, wednesdayEvening, html: (when: number) => coachSectionFor(store, when) };
}

describe('the coach across a fixture week', () => {
  it('a week that stays on its goals raises no nudge', async () => {
    const { store, calls, wednesdayEvening } = await runWeek(ON_TRACK_WEEK);
    expect(wednesdayEvening).not.toContain('data-nudge=');
    expect(calls.length).toBeGreaterThan(0);
    expect(store.passes().filter((p) => p.outcome === 'nudged')).toHaveLength(0);
    expect(store.openNudge(at(2, 18))).toBeNull();
  });

  it('a week that drifts on Wednesday raises one nudge, naming the goal and the drift', async () => {
    const { store, html, wednesdayEvening: page } = await runWeek(DRIFTING_WEEK);
    const nudged = store.passes().filter((p) => p.outcome === 'nudged');
    expect(nudged).toHaveLength(1);
    const wednesday = store.nudgesToday(at(2, 20));
    expect(wednesday).toHaveLength(1);
    const n = wednesday[0];
    expect(n?.goal).toBe('Publish the Harborlight launch post');
    expect(n?.drift).toContain('Board colour tokens');
    // While it is open, later checks that day do not ask the model again.
    expect(store.passes().some((p) => p.outcome === 'nudge-open')).toBe(true);
    // On the page that evening: the question, the drift, the goal's number.
    expect(page).toContain('Is publishing the launch post still first this week?');
    expect(page).toContain('Board colour tokens');
    expect(page).toContain('goal 1');
    // Unanswered, it leaves the page the next day and is kept as expired.
    expect(html(at(3, 10))).not.toContain('data-nudge=');
    expect(store.nudgesToday(at(2, 20))[0]?.state).toBe('expired');
  });

  it("reads only the owner's rows: the agent's afternoon never reaches the prompt", async () => {
    const { calls } = await runWeek(ON_TRACK_WEEK);
    const monday = calls.find((c) => c.includes('Monday'));
    expect(monday).toBeDefined();
    expect(monday).not.toContain('Board colour tokens');
    expect(monday).toContain('Harborlight launch post draft');
  });
});

describe('the gates in front of the model', () => {
  const quiet = async (setup: (store: CoachStore) => void) => {
    const store = new CoachStore(dir, at(2, 15));
    setup(store);
    const calls: string[] = [];
    const coach = createCoach({
      store,
      readRows: () => DRIFTING_WEEK.filter((r) => Date.parse(r.ts) <= at(2, 15)),
      label: () => ({}),
      generate: scorer(calls),
      now: () => at(2, 15),
      log: () => {},
    });
    return { rec: await coach.check(), calls };
  };

  it('no goals for the week: no call', async () => {
    const { rec, calls } = await quiet(() => {});
    expect(rec.outcome).toBe('no-goals');
    expect(calls).toHaveLength(0);
  });

  it('two nudges already today: no call', async () => {
    const { rec, calls } = await quiet((s) => {
      s.setGoals(GOALS, ZONE, at(0, 8));
      for (const h of [10, 12]) {
        const n = s.addNudge({
          at: at(2, h),
          goalIndex: 0,
          goal: GOALS[0] ?? '',
          drift: 'x'.repeat(10),
          question: 'Still on it?',
        });
        s.answer(n.id, 'back-to-it', at(2, h, 5));
      }
    });
    expect(rec.outcome).toBe('daily-cap');
    expect(calls).toHaveLength(0);
  });

  it('nothing new since the last call: no second call', async () => {
    const store = new CoachStore(dir, at(2, 18));
    store.setGoals(GOALS, ZONE, at(0, 8));
    const calls: string[] = [];
    let clock = at(1, 18);
    const coach = createCoach({
      store,
      readRows: () => ON_TRACK_WEEK.filter((r) => Date.parse(r.ts) <= at(1, 17)),
      label: () => ({}),
      generate: scorer(calls),
      now: () => clock,
      log: () => {},
    });
    expect((await coach.check()).outcome).toBe('on-track');
    clock = at(1, 20, 30);
    expect((await coach.check()).outcome).toBe('no-new-activity');
    expect(calls).toHaveLength(1);
  });

  it('a reply that is not the expected JSON raises nothing', async () => {
    const store = new CoachStore(dir, at(2, 15));
    store.setGoals(GOALS, ZONE, at(0, 8));
    const coach = createCoach({
      store,
      readRows: () => DRIFTING_WEEK.filter((r) => Date.parse(r.ts) <= at(2, 15)),
      label: () => ({}),
      generate: async () => 'You seem to be drifting! Focus on goal 1.',
      now: () => at(2, 15),
      log: () => {},
    });
    expect((await coach.check()).outcome).toBe('unusable-reply');
    expect(store.openNudge(at(2, 15))).toBeNull();
  });
});
