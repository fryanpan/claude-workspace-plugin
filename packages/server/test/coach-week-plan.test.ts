/**
 * Each coach digest carries this week's plan goals, id and title, in plan
 * order, so the coach judges priority from the plan rather than from task
 * titles. No plan board, no "Week of" date, or a week that has passed reads
 * as no current plan, with no goals listed.
 */
import { describe, expect, it } from 'bun:test';
import { DIGEST_WINDOW_MS, SessionFeed, type SessionFrame } from '../src/coach/session-feed.ts';
import {
  NO_WEEK_PLAN,
  type PlanBoardReading,
  weekPlanOf,
  weekStartOf,
} from '../src/coach/week-plan.ts';

const ZONE = 'America/Los_Angeles';
/** Tuesday 6 October 2026, 10:00 in Los Angeles. */
const TUESDAY = Date.UTC(2026, 9, 6, 17, 0);
const DAY = 86_400_000;

const plan = (name: string): PlanBoardReading => ({
  name,
  goals: [
    { id: 'g-harbor', title: 'Harborlight ships the berth map' },
    { id: 'g-river', title: 'Riverbend answers every ask' },
    { id: 'g-salt', title: 'Saltmarsh signs in' },
  ],
});

function digestFrom(board: PlanBoardReading | undefined, start: number) {
  let now = start;
  let fire: (() => void) | undefined;
  const sent: SessionFrame[] = [];
  const feed = new SessionFeed({
    now: () => now,
    schedule: (fn) => {
      fire = fn;
      return () => {};
    },
    lead: () => ({ workspaceId: 'w-coach', agentId: 'agent-coach' }),
    connected: () => true,
    send: (_ws, _agent, frame) => {
      sent.push(frame);
      return 1;
    },
    eventsOn: () => 0,
    countTurn: () => {},
    planBoard: () => board,
    timeZone: () => ZONE,
  });
  feed.send({ event: 'coach.event', kind: 'view', boardId: 'w-harbor', board: 'Harborlight' }, now);
  now += DIGEST_WINDOW_MS;
  fire?.();
  const frame = sent[0];
  if (frame?.event !== 'coach.digest') throw new Error('no digest was sent');
  return frame;
}

describe('the coach digest carries the week plan', () => {
  it('lists the current plan goals in plan order, id and title only', () => {
    const frame = digestFrom(plan('Team Lead · Week of 5 Oct'), TUESDAY);
    expect(frame.plan).toEqual({
      week: '2026-10-05',
      goals: [
        { id: 'g-harbor', title: 'Harborlight ships the berth map' },
        { id: 'g-river', title: 'Riverbend answers every ask' },
        { id: 'g-salt', title: 'Saltmarsh signs in' },
      ],
    });
  });

  it('says there is no current week plan when there is no plan board', () => {
    expect(digestFrom(undefined, TUESDAY).plan).toBe(NO_WEEK_PLAN);
  });

  it('says there is no current week plan once the week has passed', () => {
    const board = plan('Week of 5 Oct');
    expect(digestFrom(board, TUESDAY + 5 * DAY).plan).not.toBe(NO_WEEK_PLAN);
    expect(digestFrom(board, TUESDAY + 6 * DAY).plan).toBe(NO_WEEK_PLAN);
  });
});

describe('weekPlanOf', () => {
  it('reads the week from a goal title when the board name has none', () => {
    const board: PlanBoardReading = {
      name: 'Team Lead',
      goals: [
        { id: 'g-week', title: 'Week of Oct 5: Harborlight first' },
        { id: 'g-river', title: 'Riverbend' },
      ],
    };
    expect(weekPlanOf(board, TUESDAY, ZONE)).toEqual({
      week: '2026-10-05',
      goals: [
        { id: 'g-week', title: 'Week of Oct 5: Harborlight first' },
        { id: 'g-river', title: 'Riverbend' },
      ],
    });
  });

  it('does not guess when nothing names a week', () => {
    expect(weekPlanOf(plan('Team Lead'), TUESDAY, ZONE)).toBe(NO_WEEK_PLAN);
  });

  it('does not count a week that has not started', () => {
    expect(weekPlanOf(plan('Week of 12 Oct'), TUESDAY, ZONE)).toBe(NO_WEEK_PLAN);
  });

  it('reads the day in the owner zone, not UTC', () => {
    // Sunday 11 Oct, 20:00 in Los Angeles is already Monday 12 Oct in UTC.
    const sundayEvening = Date.UTC(2026, 9, 12, 3, 0);
    expect(weekPlanOf(plan('Week of 5 Oct'), sundayEvening, ZONE)).not.toBe(NO_WEEK_PLAN);
    expect(weekPlanOf(plan('Week of 5 Oct'), sundayEvening, 'UTC')).toBe(NO_WEEK_PLAN);
  });
});

describe('weekStartOf', () => {
  const today = Date.UTC(2026, 9, 6) / DAY;
  const oct5 = Date.UTC(2026, 9, 5) / DAY;

  it('reads the date forms a plan is written in', () => {
    for (const text of [
      'Week of 2026-10-05',
      'Week of 5 Oct',
      'week of 5th October',
      'Week of Oct 5',
      'Week of October 5, 2026',
      'Plan — Week of 5 Oct 2026',
    ]) {
      expect(weekStartOf(text, today)).toBe(oct5);
    }
  });

  it('takes the nearest year when a date has none', () => {
    const lateDecember = Date.UTC(2026, 11, 30) / DAY;
    expect(weekStartOf('Week of 4 Jan', lateDecember)).toBe(Date.UTC(2027, 0, 4) / DAY);
  });

  it('answers nothing for a phrase that is not a date', () => {
    expect(weekStartOf('Week of Harborlight', today)).toBeUndefined();
    expect(weekStartOf('Week of 31 Feb', today)).toBeUndefined();
    expect(weekStartOf('Riverbend', today)).toBeUndefined();
  });
});
