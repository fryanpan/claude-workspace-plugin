/**
 * Interview mode, driven through `SpokenAnswerer` over a real `DocStore`:
 * "interview me" on a plan with four gaps, a scripted run of answers and
 * commands, and the doc read back through its outline afterwards.
 *
 * The answers are written by `applyBlockEdits`, so the comments anchored in
 * the plan are checked to cover the same words at the end.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { type Fixture, planFixture } from './interview-fixture.ts';

let fx: Fixture | null = null;
afterEach(() => {
  fx?.stop();
  fx = null;
});

async function started(): Promise<Fixture> {
  fx = await planFixture();
  const first = await fx.say('Claude, interview me.');
  expect(first.route).toBe('interview');
  expect(first.asking).toBe(true);
  return fx;
}

const GOALS = 'Cut the crossing to twenty minutes so commuters switch from the bridge.';
const DESIGN = 'A drive-through deck with ramps at both ends.';
const REQS = 'The harbour board signs off, after the tide survey.';
const ROLLOUT = 'Start with weekday sailings in March, then weekends.';

describe('interview mode: each answer lands in its section', () => {
  it('asks the gaps most important first and writes every answer under its heading', async () => {
    fx = await planFixture();
    const f = fx;
    const first = await f.say('Claude, interview me.');
    expect(first).toMatchObject({
      spoken: 'I found 4 gaps. First: What goes under Goals?',
      asking: true,
      route: 'interview',
    });
    expect(first.detail).toEqual([
      '1. Goals — empty',
      '2. Design — placeholder only',
      '3. Requirements — open question',
      '4. Rollout — short',
    ]);

    f.tick(90_000);
    expect((await f.say(GOALS)).spoken).toBe('Written under Goals. Next: What goes under Design?');
    f.tick(60_000);
    expect((await f.say(DESIGN)).spoken).toBe(
      'Written under Design. Next: Under Requirements: Who signs off the berth design?',
    );
    f.tick(120_000);
    expect((await f.say(REQS)).spoken).toBe(
      'Written under Requirements. Next: Rollout is short. What else should it say?',
    );
    f.tick(30_000);
    const last = await f.say(ROLLOUT);
    expect(last).toMatchObject({
      spoken: 'Written under Rollout. That was the last gap. 4 of 4 gaps filled.',
      asking: false,
    });
    expect(f.interview.active).toBe(false);

    expect(f.headingOf(GOALS)).toBe('Goals');
    expect(f.headingOf(DESIGN)).toBe('Design');
    expect(f.headingOf(REQS)).toBe('Requirements');
    expect(f.headingOf(ROLLOUT)).toBe('Rollout');
    // Nothing the plan held was replaced.
    expect(f.headingOf('TBD')).toBe('Design');
    expect(f.headingOf('Carries twelve cars.')).toBe('Requirements');
    // The comments in Requirements and Rollout still cover their words.
    expect(f.anchoredText()).toEqual(['Carries twelve cars', 'Two weeks']);
  });

  it('records the time from question to written answer per section, with no doc content', async () => {
    const f = await started();
    f.tick(90_000);
    await f.say(GOALS);
    f.tick(60_000);
    await f.say(DESIGN);
    f.tick(120_000);
    await f.say(REQS);
    f.tick(30_000);
    await f.say(ROLLOUT);
    const gaps = f.rows.filter((r) => r.type === 'gap');
    expect(gaps.map((r) => [r.section, r.kind, r.outcome, r.ms])).toEqual([
      [1, 'empty', 'filled', 90_000],
      [3, 'placeholder', 'filled', 60_000],
      [2, 'question', 'filled', 120_000],
      [4, 'thin', 'filled', 30_000],
    ]);
    expect(f.rows.at(-1)).toMatchObject({
      type: 'end',
      docId: 'd-plan',
      gaps: 4,
      filled: 4,
      skipped: 0,
      ms: 300_000,
      minutesPerFilled: 1.25,
    });
    expect(f.lines.at(-1)).toBe(
      '[interview] done doc=d-plan gaps=4 filled=4 skipped=0 ms=300000 minutesPerFilled=1.25',
    );
    const recorded = JSON.stringify(f.rows) + f.lines.join('\n');
    for (const words of ['Goals', 'Design', 'commuters', 'berth', 'Harborlight ferry']) {
      expect(recorded).not.toContain(words);
    }
  });

  it('an answer that only mentions a command word is written', async () => {
    const f = await started();
    const said = 'We skip the staging deploy and ship from the harbour office.';
    expect((await f.say(said)).spoken).toStartWith('Written under Goals.');
    expect(f.headingOf(said)).toBe('Goals');
  });

  it('nothing heard asks the same question again and writes nothing', async () => {
    const f = await started();
    const again = await f.say('');
    expect(again).toMatchObject({
      spoken: 'I didn’t catch that. What goes under Goals?',
      asking: true,
    });
    expect(f.rows).toEqual([]);
  });

  it('a heading deleted mid-interview is reported and the next gap asked', async () => {
    const f = await started();
    const goals = f.docStore
      .readOutline('d-plan')
      ?.blocks.find((b) => b.text === 'Goals');
    f.docStore.applyBlockEdits(
      'd-plan',
      [{ op: 'delete_block', blockId: goals?.id ?? '' }],
      {
        author: 'fixture',
      },
    );
    const r = await f.say(GOALS);
    expect(r.spoken).toBe('Goals is gone from the doc. Next: What goes under Design?');
    expect(f.headingOf(GOALS)).toBeNull();
    expect(f.rows[0]).toMatchObject({ outcome: 'gone' });
  });
});

describe('interview mode: where it starts', () => {
  it('refuses a doc that is not on this board, and reads nothing from it', async () => {
    fx = await planFixture({ onBoard: false });
    const r = await fx.say('interview me');
    expect(r).toMatchObject({ spoken: 'Open a plan and say interview me there.', asking: false });
    expect(fx.interview.active).toBe(false);
  });

  it('off a doc, says where to say it', async () => {
    fx = await planFixture();
    const r = await fx.say('interview me', { surface: 'board' });
    expect(r.spoken).toBe('Open a plan and say interview me there.');
  });

  it('a plan with no gaps says so', async () => {
    fx = await planFixture({
      markdown:
        '# Plan\n\n## Goals\n\nShip the second ferry crossing before the spring timetable starts.\n',
    });
    expect((await fx.say('interview me')).spoken).toBe('I found no gaps in this plan.');
  });

  it('anything else said goes to the router, as before', async () => {
    fx = await planFixture();
    const r = await fx.say('give me a status update');
    expect(r.route).toBe('fast-path');
    expect(fx.interview.active).toBe(false);
  });
});
