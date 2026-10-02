/**
 * What the router eval says, where it says it, and what the router should
 * do about it. Every utterance is invented, over the fixture boards in
 * `voice-router-fixture.ts`.
 *
 * The expected outcome is what Alice would see happen: which page opens,
 * which task moves, where her words land, or that the request went to the
 * lead agent. `also` lists an outcome that is just as right. Near misses —
 * a neighbouring task or doc with shared words, a thing that only exists on
 * the similarly named Harborlight Ops board — are marked `near`.
 */
import type { GoalKey, TaskKey } from './voice-router-fixture.ts';

export type PageKind = 'board' | 'task' | 'doc' | 'review-item' | 'meeting' | 'mock';
export const PAGE_KINDS: readonly PageKind[] = [
  'board',
  'task',
  'doc',
  'review-item',
  'meeting',
  'mock',
];

/** Where the speaker is: a task by key, a doc by id, a thread open on it. */
export type Where =
  | { board: true }
  | { task: TaskKey; thread?: string }
  | { doc: string; thread?: string };

export type Outcome =
  | { open: TaskKey | GoalKey | string }
  | { ask: true }
  | { status: TaskKey; to: 'todo' | 'in-progress' | 'done' }
  | { assign: TaskKey; to: string }
  | { comment: TaskKey | string }
  | { answer: string; option?: string }
  | { brief: true }
  | { agent: true };

export interface RouterCase {
  kind: PageKind;
  where: Where;
  said: string;
  expect: Outcome;
  also?: Outcome[];
  near?: true;
}

const BOARD: Where = { board: true };
const AGENT: Outcome = { agent: true };
const BERTH: Where = { doc: 'berth-plan' };
const WINTER: Where = { doc: 'winter-plan' };
const SYNC: Where = { doc: 'weekly-sync' };
const MOCK: Where = { doc: 'booking-mock' };
const TIMETABLE: Where = { task: 'timetable' };

const c = (
  kind: PageKind,
  where: Where,
  said: string,
  expect: Outcome,
  more: { also?: Outcome[]; near?: true } = {},
): RouterCase => ({ kind, where, said, expect, ...more });

export const ROUTER_CORPUS: RouterCase[] = [
  // ── board ──
  c('board', BOARD, 'open the ferry timetable task', { open: 'timetable' }, { near: true }),
  c('board', BOARD, 'show me the ferry ticketing task', { open: 'ticketing' }, { near: true }),
  c('board', BOARD, 'open the berth survey', { open: 'survey' }, { near: true }),
  c('board', BOARD, 'open the Riverbend berth', { ask: true }, { near: true, also: [AGENT] }),
  c('board', BOARD, 'go to the winter schedule plan', { open: 'winter-plan' }, { near: true }),
  c('board', BOARD, "what's the status of the board", { brief: true }),
  c('board', BOARD, 'take me home', { open: 'home' }),
  c('board', BOARD, 'open my top goal', { open: 'crossing' }),
  c('board', BOARD, 'add a task to repaint the Saltmarsh signs', AGENT),
  c('board', BOARD, 'open the tide table task', AGENT, { near: true }),
  c('board', BOARD, 'open the Harborlight Ops board', AGENT, { near: true }),
  c('board', BOARD, 'move the parking signs task to the top of the list', AGENT),
  c('board', BOARD, 'find the crew rota', AGENT, { near: true }),
  c('board', BOARD, 'pull up the thing about ticket sales', { open: 'ticketing' }),

  // ── task ──
  c('task', TIMETABLE, 'mark this done', { status: 'timetable', to: 'done' }),
  c('task', TIMETABLE, "I've started on this one", { status: 'timetable', to: 'in-progress' }),
  c('task', TIMETABLE, 'assign this to Bob', { assign: 'timetable', to: 'Bob' }),
  c('task', TIMETABLE, 'assign it to me', { assign: 'timetable', to: 'Alice' }),
  c('task', TIMETABLE, 'comment: the Saturday sailings need a second crew', {
    comment: 'timetable',
  }),
  c('task', TIMETABLE, 'open the ticketing task', { open: 'ticketing' }, { near: true }),
  c('task', TIMETABLE, 'mark the ticketing task done', AGENT, { near: true }),
  c('task', TIMETABLE, 'split this into a summer and a winter version', AGENT),
  c('task', { task: 'winter' }, 'open the linked doc', { open: 'winter-plan' }),
  c('task', { task: 'ticketing' }, 'put this back to to do', { status: 'ticketing', to: 'todo' }),
  c(
    'task',
    { task: 'parking' },
    'reopen this',
    { status: 'parking', to: 'todo' },
    {
      also: [{ status: 'parking', to: 'in-progress' }],
    },
  ),
  c('task', { task: 'survey' }, "we're finished with the survey, close it out", {
    status: 'survey',
    to: 'done',
  }),
  c('task', { task: 'repairs' }, 'open the berth survey task', { open: 'survey' }, { near: true }),

  // ── doc ──
  c('doc', BERTH, 'open the berth survey task', { open: 'survey' }, { near: true }),
  c('doc', BERTH, 'comment: the survey dates clash with the spring tides', {
    comment: 'berth-plan',
  }),
  c('doc', BERTH, 'add a section on dredging', AGENT),
  c('doc', BERTH, 'go back to the board', { open: 'tasks' }),
  c('doc', BERTH, 'open the berth repairs', { open: 'repairs' }, { near: true }),
  c('doc', WINTER, 'open the timetable task', { open: 'timetable' }, { near: true }),
  c('doc', WINTER, 'rewrite the intro so it is shorter', AGENT),
  c('doc', BERTH, "what's waiting on me", { brief: true }),
  c('doc', WINTER, 'open the signage review', { open: 'signage-review' }),
  c('doc', BERTH, 'mark this done', AGENT),
  c(
    'doc',
    BERTH,
    'note that Bob checked the soundings',
    { comment: 'berth-plan' },
    {
      also: [AGENT],
    },
  ),

  // ── review item ──
  c('review-item', { doc: 'winter-plan', thread: 'th-sailing' }, 'yes keep the 7am sailing', {
    answer: 'th-sailing',
  }),
  c('review-item', { doc: 'winter-plan', thread: 'th-sailing' }, 'answer: drop it until March', {
    answer: 'th-sailing',
  }),
  c('review-item', { doc: 'booking-mock', thread: 'th-header' }, 'keep the blue header', {
    answer: 'th-header',
    option: 'Keep the blue header',
  }),
  c('review-item', { doc: 'booking-mock', thread: 'th-header' }, 'use the white one', {
    answer: 'th-header',
    option: 'Use the white header',
  }),
  c('review-item', { doc: 'booking-mock', thread: 'th-header' }, 'the second one', {
    answer: 'th-header',
    option: 'Use the white header',
  }),
  c('review-item', { doc: 'signage-review', thread: 'th-font' }, 'sans', {
    answer: 'th-font',
    option: 'Sans',
  }),
  c(
    'review-item',
    { doc: 'signage-review' },
    'go with sans for the font',
    {
      answer: 'th-font',
      option: 'Sans',
    },
    { near: true },
  ),
  c('review-item', { doc: 'signage-review', thread: 'th-sign' }, 'yes the wording is final', {
    answer: 'th-sign',
  }),
  c('review-item', { doc: 'winter-plan', thread: 'th-sailing' }, 'open the ferry timetable task', {
    open: 'timetable',
  }),
  c('review-item', { doc: 'booking-mock', thread: 'th-header' }, 'make the header taller', AGENT),
  c('review-item', { task: 'tide', thread: 'th-slip' }, 'south', {
    answer: 'th-slip',
    option: 'South slipway',
  }),
  c(
    'review-item',
    { doc: 'winter-plan', thread: 'th-sailing' },
    'comment on the berth plan that the dates moved',
    AGENT,
    { near: true },
  ),

  // ── meeting ──
  c('meeting', SYNC, 'open the ferry ticketing task', { open: 'ticketing' }),
  c('meeting', SYNC, 'make a task to call the Saltmarsh council', AGENT),
  c('meeting', SYNC, "what's the status", { brief: true }),
  c('meeting', SYNC, 'open the berth survey', { open: 'survey' }, { near: true }),
  c('meeting', SYNC, 'comment: Bob will send the tide tables', { comment: 'weekly-sync' }),
  c('meeting', SYNC, 'go to activity', { open: 'activity' }),
  c('meeting', SYNC, 'summarize this meeting', AGENT),
  c('meeting', SYNC, 'open the winter plan', { open: 'winter-plan' }, { near: true }),
  c('meeting', SYNC, 'open the ticket sales task', { open: 'ticketing' }),
  c('meeting', SYNC, 'assign the parking signs to Bob', AGENT),
  c('meeting', SYNC, 'open the crew rota', AGENT, { near: true }),

  // ── mock ──
  c('mock', MOCK, 'comment: the book button is too small on a phone', {
    comment: 'booking-mock',
  }),
  c('mock', MOCK, 'keep the blue header', {
    answer: 'th-header',
    option: 'Keep the blue header',
  }),
  c('mock', MOCK, 'open the ticketing task', { open: 'ticketing' }),
  c('mock', MOCK, 'make the header taller', AGENT),
  c('mock', MOCK, 'go home', { open: 'home' }),
  c('mock', MOCK, 'open the booking mock', { open: 'booking-mock' }),
  c('mock', MOCK, "what's left on the board", { brief: true }),
  c('mock', MOCK, 'open the winter schedule task', { open: 'winter' }, { near: true }),
  c('mock', MOCK, 'send this to Riverbend for review', AGENT),
  c('mock', MOCK, 'open the timetable', { open: 'timetable' }),
  c('mock', MOCK, 'mark the mock approved', AGENT),
];
