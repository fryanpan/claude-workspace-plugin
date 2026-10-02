/**
 * "skip", "come back to that" and "that's enough" in a running interview,
 * each with the other ways people say it, over the same four-gap plan as
 * `spoken-reply-interview.test.ts`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { interviewCommand } from '../src/spoken-reply/interview-phrases.ts';
import { type Fixture, planFixture } from './interview-fixture.ts';

let fx: Fixture | null = null;
afterEach(() => {
  fx?.stop();
  fx = null;
});

async function started(): Promise<Fixture> {
  fx = await planFixture();
  await fx.say('interview me');
  return fx;
}

describe('skip', () => {
  for (const said of [
    'skip',
    'Skip that.',
    'Claude, skip it please',
    'next one',
    'move on',
    'pass',
  ]) {
    it(`"${said}" moves to the next gap and writes nothing`, async () => {
      const f = await started();
      const r = await f.say(said);
      expect(r).toMatchObject({
        spoken: 'Skipped. Next: What goes under Design?',
        asking: true,
      });
      expect(f.headingOf(said)).toBeNull();
      expect(f.rows).toEqual([expect.objectContaining({ section: 1, outcome: 'skipped' })]);
    });
  }

  it('a skipped gap is not asked again', async () => {
    const f = await started();
    await f.say('skip');
    await f.say('A drive-through deck.');
    await f.say('The harbour board.');
    const last = await f.say('Weekdays first.');
    expect(last.spoken).toBe('Written under Rollout. That was the last gap. 3 of 4 gaps filled.');
    expect(f.rows.at(-1)).toMatchObject({ type: 'end', filled: 3, skipped: 1 });
  });
});

describe('come back to that', () => {
  for (const said of [
    'come back to that',
    "Let's come back to it later.",
    'ask me later',
    'park that',
    'leave it for now',
  ]) {
    it(`"${said}" moves on and asks that gap again after the others`, async () => {
      const f = await started();
      expect((await f.say(said)).spoken).toBe(
        'I’ll come back to that. Next: What goes under Design?',
      );
      await f.say('A drive-through deck.');
      await f.say('The harbour board.');
      expect((await f.say('Weekdays first.')).spoken).toBe(
        'Written under Rollout. Next: What goes under Goals?',
      );
      const done = await f.say('Twenty-minute crossings.');
      expect(done.spoken).toBe('Written under Goals. That was the last gap. 4 of 4 gaps filled.');
      expect(f.headingOf('Twenty-minute crossings.')).toBe('Goals');
      expect(f.rows[0]).toMatchObject({ section: 1, outcome: 'deferred' });
    });
  }

  it('the only gap left is asked again at once, and says so', async () => {
    fx = await planFixture({
      markdown:
        '# Plan\n\n## Goals\n\n## Notes\n\nThe crossing runs between Riverbend and the Saltmarsh quay all year.\n',
    });
    await fx.say('interview me');
    expect((await fx.say('come back to that')).spoken).toBe(
      'I’ll come back to that. It’s the only one left: What goes under Goals?',
    );
  });
});

describe("that's enough", () => {
  for (const said of [
    "that's enough",
    'That is enough.',
    "that's all for now",
    'stop the interview',
    "we're done",
    'enough',
  ]) {
    it(`"${said}" ends the interview and keeps what was written`, async () => {
      const f = await started();
      await f.say('Twenty-minute crossings.');
      const r = await f.say(said);
      expect(r).toMatchObject({
        spoken: 'Stopping here. 1 of 4 gaps filled.',
        asking: false,
        route: 'interview',
      });
      expect(r.detail).toEqual([
        'Not asked: Requirements — open question',
        'Not asked: Rollout — short',
      ]);
      expect(f.interview.active).toBe(false);
      expect(f.headingOf('Twenty-minute crossings.')).toBe('Goals');
      expect(f.rows.at(-1)).toMatchObject({ type: 'end', filled: 1, gaps: 4 });
      // What is said next is the board mic's again.
      expect((await f.say('give me a status update')).route).toBe('fast-path');
    });
  }
});

describe('interviewCommand', () => {
  it('reads whole utterances only', () => {
    expect(interviewCommand('Hey Claude, interview me')).toBe('start');
    expect(interviewCommand('start the interview')).toBe('start');
    expect(interviewCommand('say that again')).toBe('repeat');
    expect(interviewCommand('um, skip')).toBe('skip');
    expect(interviewCommand('We skip the staging deploy.')).toBeNull();
    expect(interviewCommand('Come back to that after the survey is in.')).toBeNull();
    expect(interviewCommand('Enough cars for a full deck.')).toBeNull();
    expect(interviewCommand('')).toBeNull();
  });

  it('"say that again" repeats the question in a running interview', async () => {
    const f = await started();
    expect((await f.say('say that again')).spoken).toBe('What goes under Goals?');
  });
});
