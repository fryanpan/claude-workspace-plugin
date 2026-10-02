/**
 * The interview's slot machine on its own: each transition, the queue it
 * leaves, and the once-per-slot silence offer.
 */
import { describe, expect, it } from 'bun:test';
import type { PlanGap } from '../src/spoken-reply/interview-gaps.ts';
import { InterviewSlots } from '../src/spoken-reply/interview-state.ts';

const gap = (heading: string, ordinal: number): PlanGap => ({
  headingId: `h${ordinal}`,
  heading,
  kind: 'empty',
  ordinal,
  rank: 3,
});
const GAPS = [gap('Goals', 1), gap('Design', 2), gap('Rollout', 3)];
const heading = (s: InterviewSlots) => s.current?.heading ?? null;

describe('InterviewSlots', () => {
  it('asks each slot once, in order, and counts what was placed and skipped', () => {
    const s = new InterviewSlots(GAPS);
    expect(heading(s)).toBe('Goals');
    expect(s.settle('placed')).toMatchObject({ again: false });
    expect(heading(s)).toBe('Design');
    s.settle('skipped');
    expect(s.settle('gone')).toEqual({ next: null, again: false });
    expect(s.current).toBeNull();
    expect([s.total, s.placed, s.skipped]).toEqual([3, 1, 1]);
  });

  it('a deferred slot goes to the back, and comes straight back when it is the only one', () => {
    const s = new InterviewSlots(GAPS);
    s.settle('deferred');
    expect(s.unasked.map((g) => g.heading)).toEqual(['Rollout', 'Goals']);
    s.settle('placed');
    s.settle('placed');
    expect(heading(s)).toBe('Goals');
    expect(s.settle('deferred')).toMatchObject({ again: true });
    expect(heading(s)).toBe('Goals');
  });

  it('ended stops on the current slot and leaves the rest unasked', () => {
    const s = new InterviewSlots(GAPS);
    s.settle('placed');
    expect(s.settle('ended')).toEqual({ next: null, again: false });
    expect(s.unasked.map((g) => g.heading)).toEqual(['Rollout']);
    expect(s.settle('placed')).toEqual({ next: null, again: false });
    expect(s.placed).toBe(1);
  });

  it('offers to skip once per slot on silence', () => {
    const s = new InterviewSlots(GAPS);
    expect([s.silence(), s.silence()]).toEqual(['offer-skip', 'repeat']);
    s.settle('skipped');
    expect(s.silence()).toBe('offer-skip');
  });

  it('rebind keeps the slot and its place, with the new heading id', () => {
    const s = new InterviewSlots(GAPS);
    s.rebind('h9');
    expect(s.current).toMatchObject({ heading: 'Goals', headingId: 'h9' });
    s.settle('deferred');
    expect(s.unasked.at(-1)?.headingId).toBe('h9');
  });
});
