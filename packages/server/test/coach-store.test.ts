/**
 * The coach's calendar and its one file: when it may speak, what each
 * answer does to that, the weekly review offer, and that nothing saved is
 * ever lost.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localDay, spacingAllows } from '../src/coach/clock.ts';
import { CoachStore } from '../src/coach/store.ts';
import { MOMENT_TTL_MS, REVIEW_AFTER_MS } from '../src/coach/types.ts';
import { ZONE, at } from './coach-fixtures.ts';

const moment = (when: number) => ({
  at: when,
  goalIndex: 0,
  goal: 'Do the hard work first',
  matched: 'more than twenty minutes on styling',
  observed: 'Half an hour on the hover mock',
  line: 'Hi, I’m noticing half an hour on hover states. Back to the post?',
});

let dir: string;
let store: CoachStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coach-store-'));
  store = new CoachStore(dir, at(8));
  store.noteTimeZone(ZONE);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('when the coach may speak', () => {
  it('waits his setting after a moment, and each “not now” today doubles it', () => {
    expect(spacingAllows(at(9), [], 'normal', ZONE)).toBe(true);
    const m = store.addMoment(moment(at(9)));
    expect(spacingAllows(at(9, 59), store.moments(), 'normal', ZONE)).toBe(false);
    expect(spacingAllows(at(10), store.moments(), 'normal', ZONE)).toBe(true);
    expect(spacingAllows(at(9, 30), store.moments(), 'more', ZONE)).toBe(true);
    expect(spacingAllows(at(11), store.moments(), 'less', ZONE)).toBe(false);
    store.answer(m.id, 'not-now', at(9, 2));
    expect(spacingAllows(at(10, 30), store.moments(), 'normal', ZONE)).toBe(false);
    expect(spacingAllows(at(11), store.moments(), 'normal', ZONE)).toBe(true);
  });

  it('names the local day in his zone, not UTC', () => {
    expect(localDay(at(23, 30), ZONE)).toBe('2026-10-07');
  });
});

describe('the moments', () => {
  it('closes one he left after its time, and takes an answer only once', () => {
    const m = store.addMoment(moment(at(9)));
    expect(store.openMoment(at(9, 5))?.id).toBe(m.id);
    expect(store.answer(m.id, 'thanks', at(9, 6))).toBe(true);
    expect(store.answer(m.id, 'not-this', at(9, 7))).toBe(false);
    const left = store.addMoment(moment(at(11)));
    expect(store.openMoment(at(11) + MOMENT_TTL_MS)).toBeNull();
    expect(store.moments().find((x) => x.id === left.id)?.state).toBe('expired');
  });

  it('counts the week: answers, unanswered, and the quiet share of judgements', () => {
    const a = store.addMoment(moment(at(9)));
    store.answer(a.id, 'not-this', at(9, 1));
    store.addMoment(moment(at(11)));
    store.openMoment(at(12));
    store.recordJudgement({ at: at(9), outcome: 'moment', cause: 'trigger' });
    store.recordJudgement({ at: at(10), outcome: 'quiet', cause: 'trigger' });
    store.recordJudgement({ at: at(10, 30), outcome: 'quiet', cause: 'trigger' });
    expect(store.week(at(12))).toEqual({
      moments: 2,
      thanks: 0,
      notNow: 0,
      notThis: 1,
      unanswered: 1,
      judgements: 3,
      quiet: 2,
    });
  });
});

describe('the weekly review offer', () => {
  it('is due a week after the last change, and a week after “no update needed”', () => {
    expect(store.reviewDue(at(8))).toBe(false); // no doc yet
    store.setGoalsDoc({ workspaceId: 'w-coach', docId: 'd-goals', createdAt: at(8) });
    expect(store.reviewDue(at(8) + REVIEW_AFTER_MS - 1)).toBe(false);
    expect(store.reviewDue(at(8) + REVIEW_AFTER_MS)).toBe(true);
    store.declineReview(at(8) + REVIEW_AFTER_MS);
    expect(store.reviewDue(at(8) + REVIEW_AFTER_MS * 2 - 1)).toBe(false);
    store.noteGoalsChanged(at(8) + REVIEW_AFTER_MS * 2);
    expect(store.reviewDue(at(8) + REVIEW_AFTER_MS * 2 + 1)).toBe(false);
  });
});

describe('the file', () => {
  it('survives a restart, owner-only, and a bad setting falls back', () => {
    store.setSpacing('less');
    store.addMoment(moment(at(9)));
    const path = join(dir, 'coach', 'state.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = new CoachStore(dir, at(10));
    expect(again.spacing).toBe('less');
    expect(again.timeZone).toBe(ZONE);
    expect(again.moments()).toHaveLength(1);
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...raw, spacing: 'always', timeZone: 'Mars/Olympus' }));
    const fixed = new CoachStore(dir, at(10));
    expect(fixed.spacing).toBe('normal');
    expect(fixed.timeZone).not.toBe('Mars/Olympus');
  });

  it('moves a corrupt file aside and starts empty', () => {
    store.setSpacing('more');
    writeFileSync(join(dir, 'coach', 'state.json'), '{not json');
    const fresh = new CoachStore(dir, at(10));
    expect(fresh.spacing).toBe('normal');
    expect(fresh.moments()).toEqual([]);
  });
});
