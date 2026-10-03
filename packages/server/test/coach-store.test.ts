/**
 * The coach's calendar and its one file: which week a goal list belongs to,
 * when a check is due, and that nothing saved is ever lost.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDue, localDay, weekOf } from '../src/coach/clock.ts';
import { CoachStore, cleanGoals } from '../src/coach/store.ts';
import { ZONE, at } from './coach-fixtures.ts';

describe('the coach calendar', () => {
  it('names a week by its Monday, in Bryan’s zone rather than UTC', () => {
    expect(weekOf(at(0, 9), ZONE)).toBe('2026-10-05');
    expect(weekOf(at(6, 23, 30), ZONE)).toBe('2026-10-05'); // Sunday night, after midnight UTC
    expect(weekOf(at(7, 0, 5), ZONE)).toBe('2026-10-12');
    expect(localDay(at(2, 23, 30), ZONE)).toBe('2026-10-07');
  });

  it('is due every three hours between 9am and 9pm, and never at night', () => {
    expect(checkDue(at(2, 8, 45), undefined, ZONE)).toBe(false);
    expect(checkDue(at(2, 9), undefined, ZONE)).toBe(true);
    expect(checkDue(at(2, 11, 45), at(2, 9), ZONE)).toBe(false);
    expect(checkDue(at(2, 12), at(2, 9), ZONE)).toBe(true);
    expect(checkDue(at(2, 21), at(2, 15), ZONE)).toBe(false);
  });
});

describe('cleanGoals', () => {
  it('trims, drops blanks and refuses what is not three lines of text', () => {
    expect(cleanGoals(['  Ship it ', '', 'Write\nthe post'])).toEqual({
      goals: ['Ship it', 'Write the post'],
    });
    expect(cleanGoals('Ship it')).toEqual({ error: 'goals must be a list' });
    expect(cleanGoals(['a', 2])).toEqual({ error: 'every goal must be text' });
    expect(cleanGoals(['a', 'b', 'c', 'd'])).toEqual({ error: 'at most 3 goals' });
    expect('error' in cleanGoals(['x'.repeat(141)])).toBe(true);
  });
});

describe('CoachStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coach-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every list: an edit replaces the week’s goals and the old list stays in the file', () => {
    const store = new CoachStore(dir);
    store.setGoals(['Old goal'], ZONE, at(0, 9));
    store.setGoals(['New goal'], ZONE, at(1, 9));
    expect(store.currentGoals(at(2, 9))?.goals).toEqual(['New goal']);
    expect(store.currentGoals(at(7, 9))).toBeNull();
    const reread = new CoachStore(dir);
    expect(reread.timeZone).toBe(ZONE);
    expect(reread.currentGoals(at(2, 9))?.goals).toEqual(['New goal']);
    const path = join(dir, 'coach', 'state.json');
    expect(readFileSync(path, 'utf8')).toContain('Old goal');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('a nudge is answered once, and an unanswered one expires the next day', () => {
    const store = new CoachStore(dir);
    store.setGoals(['A goal'], ZONE, at(0, 9));
    const draft = {
      goalIndex: 0,
      goal: 'A goal',
      drift: 'Fonts all day',
      question: 'Still on it?',
    };
    const a = store.addNudge({ ...draft, at: at(2, 12) });
    expect(store.openNudge(at(2, 13))?.id).toBe(a.id);
    expect(store.answer(a.id, 'plans-changed', at(2, 13))).toBe(true);
    expect(store.answer(a.id, 'back-to-it', at(2, 14))).toBe(false);
    const b = store.addNudge({ ...draft, at: at(2, 15) });
    expect(store.openNudge(at(3, 9))).toBeNull();
    expect(store.nudgesToday(at(2, 20)).map((n) => [n.id, n.state])).toEqual([
      [a.id, 'plans-changed'],
      [b.id, 'expired'],
    ]);
  });

  it('a file that does not parse is moved aside, not overwritten', () => {
    const store = new CoachStore(dir);
    store.setGoals(['A goal'], ZONE, at(0, 9));
    const path = join(dir, 'coach', 'state.json');
    Bun.write(path, '{ not json');
    const reread = new CoachStore(dir, 1234);
    expect(reread.currentGoals(at(0, 10))).toBeNull();
    expect(readFileSync(`${path}.corrupt-1234`, 'utf8')).toBe('{ not json');
  });
});
