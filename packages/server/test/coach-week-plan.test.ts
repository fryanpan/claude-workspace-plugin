/**
 * Each coach digest carries the plan board's goals, id and title, in board
 * order, so the coach judges priority from the plan rather than from task
 * titles. It says when the list was last set, flags a list older than eight
 * days as possibly stale, and reads no plan board or an empty one as no
 * current plan.
 */
import { describe, expect, it } from 'bun:test';
import { DIGEST_WINDOW_MS, SessionFeed, type SessionFrame } from '../src/coach/session-feed.ts';
import {
  NO_WEEK_PLAN,
  type PlanBoardReading,
  planBoardReading,
  weekPlanOf,
} from '../src/coach/week-plan.ts';

const ZONE = 'America/Los_Angeles';
const DAY = 86_400_000;
/** Monday 5 October 2026, 09:00 in Los Angeles: when Team Lead set the list. */
const SET = Date.UTC(2026, 9, 5, 16, 0);
/** The next day, 10:00 there. */
const TUESDAY = SET + DAY + 60 * 60_000;

const plan = (setAt = SET): PlanBoardReading => ({
  goals: [
    { id: 'g-harbor', title: 'Harborlight ships the berth map', changedAt: setAt - 60_000 },
    { id: 'g-river', title: 'Riverbend answers every ask', changedAt: setAt },
    { id: 'g-salt', title: 'Saltmarsh signs in', changedAt: setAt - 120_000 },
  ],
});

const GOALS = [
  { id: 'g-harbor', title: 'Harborlight ships the berth map' },
  { id: 'g-river', title: 'Riverbend answers every ask' },
  { id: 'g-salt', title: 'Saltmarsh signs in' },
];

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
  it('lists the plan goals in board order, id and title only, with the day they were set', () => {
    expect(digestFrom(plan(), TUESDAY).plan).toEqual({ set: '2026-10-05', goals: GOALS });
  });

  it('says there is no current week plan when there is no plan board', () => {
    expect(digestFrom(undefined, TUESDAY).plan).toBe(NO_WEEK_PLAN);
  });

  it('says there is no current week plan when the board has no goals', () => {
    expect(digestFrom({ goals: [] }, TUESDAY).plan).toBe(NO_WEEK_PLAN);
  });

  it('keeps an old list but marks it possibly stale past eight days', () => {
    expect(digestFrom(plan(), SET + 7 * DAY).plan).toEqual({ set: '2026-10-05', goals: GOALS });
    expect(digestFrom(plan(), SET + 9 * DAY).plan).toEqual({
      set: '2026-10-05',
      stale: true,
      goals: GOALS,
    });
  });
});

describe('weekPlanOf', () => {
  it('leaves out the backlog and the decisions and urgent bands', () => {
    const board: PlanBoardReading = {
      goals: [
        { id: 'g-urgent', title: 'Urgent' },
        { id: 'g-harbor', title: 'Harborlight ships the berth map' },
        { id: 'chores', title: 'Backlog' },
        { id: 'g-decide', title: ' Decisions ' },
      ],
    };
    expect(weekPlanOf(board, TUESDAY, ZONE)).toEqual({
      goals: [{ id: 'g-harbor', title: 'Harborlight ships the berth map' }],
    });
  });

  it('reads a board of only those bands as no current plan', () => {
    const board: PlanBoardReading = { goals: [{ id: 'g-urgent', title: 'urgent' }] };
    expect(weekPlanOf(board, TUESDAY, ZONE)).toBe(NO_WEEK_PLAN);
  });

  it('names the set day in the owner zone', () => {
    // 20:00 Sunday 4 Oct in Los Angeles is already Monday 5 Oct in UTC.
    const sundayEvening = Date.UTC(2026, 9, 5, 3, 0);
    expect(weekPlanOf(plan(sundayEvening), TUESDAY, ZONE)).toMatchObject({ set: '2026-10-04' });
    expect(weekPlanOf(plan(sundayEvening), TUESDAY, 'UTC')).toMatchObject({ set: '2026-10-05' });
  });
});

describe('planBoardReading', () => {
  it('keeps board order, takes each row time, and drops an archived band', () => {
    const reading = planBoardReading(
      [
        { id: 'g-river', title: 'Riverbend' },
        { id: 'g-old', title: 'Saltmarsh' },
        { id: 'g-harbor', title: 'Harborlight' },
        { id: 'g-new', title: 'Alice' },
      ],
      [
        { id: 'g-harbor', updatedAt: 200 },
        { id: 'g-old', updatedAt: 900, archivedAt: 950 },
        { id: 'g-river', updatedAt: 100 },
      ],
    );
    expect(reading.goals).toEqual([
      { id: 'g-river', title: 'Riverbend', changedAt: 100 },
      { id: 'g-harbor', title: 'Harborlight', changedAt: 200 },
      { id: 'g-new', title: 'Alice' },
    ]);
  });
});
