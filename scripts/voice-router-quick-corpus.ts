/**
 * The router eval's quick-action cases (Bryan, 2026-10-02): what voice does on
 * the page with no agent — open something from a loose description, go
 * somewhere (another board included), start a plan or a meeting, leave
 * feedback about the app, say what voice can do — and the agent requests
 * beside them that must still reach the lead.
 *
 * The first block is Bryan's own misses, verbatim. The boards and docs they
 * name are the fixture's invented ones (`voice-router-fixture.ts`).
 *
 * Its own module so the corpus stays readable; it imports only TYPES from
 * the corpus, because the corpus imports this file's value.
 */
import type { Outcome, PageKind, RouterCase, Where } from './voice-router-corpus.ts';

const BOARD: Where = { board: true };
const AGENT: Outcome = { agent: true };
const BRIEF: Outcome = { brief: true };
const HELP: Outcome = { help: true };
const FEEDBACK: Outcome = { feedback: true };
const BERTH: Where = { doc: 'berth-plan' };
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

export const QUICK_CORPUS: RouterCase[] = [
  // ── Bryan's misses, 2 Oct ──
  c('board', BOARD, "what's occurring status", BRIEF, { also: [AGENT] }),
  c('board', BOARD, 'switch to the Team Leads workspace', { board: 'teamlead' }),
  c('board', BOARD, "take me to the Team Lead's board", { board: 'teamlead' }),
  c('board', BOARD, 'open the activities', { open: 'activity' }),
  c('board', BOARD, 'open my issues list meeting minutes', { open: 'issues-minutes' }),
  c('board', BOARD, 'open my Daily Digest', { open: 'daily-digest' }),
  c('board', BOARD, 'what can I do with voice commands', HELP),
  c('doc', BERTH, 'what can I do with voice commands', HELP),

  // ── open, loosely ──
  c('board', BOARD, 'can you bring up the minutes from the issues meeting', {
    open: 'issues-minutes',
  }),
  c('board', BOARD, 'I need the daily digest', { open: 'daily-digest' }),
  c('task', TIMETABLE, 'show me the booking page mockup', { open: 'booking-mock' }),
  c('board', BOARD, 'pull up that mock for booking', { open: 'booking-mock' }),
  c('board', BOARD, "where's the doc about the winter schedule", { open: 'winter-plan' }),
  c('meeting', SYNC, 'the berth survey task please', { open: 'survey' }, { near: true }),

  // ── go somewhere ──
  c('board', BOARD, "let's go over to the Riverbend crew board", { board: 'crew' }),
  c('doc', BERTH, 'back to the Harborlight Team Lead board', { board: 'teamlead' }),
  c('mock', MOCK, 'jump over to the crew workspace', { board: 'crew' }),
  c('task', TIMETABLE, 'show me recent activity', { open: 'activity' }),
  c('board', BOARD, "I want to see the team lead's board", { board: 'teamlead' }),
  c('meeting', SYNC, 'go to the ops board', { board: 'ops' }, { near: true }),

  // ── start a plan or a meeting ──
  c('board', BOARD, "let's make a plan", { start: 'plan' }),
  c('board', BOARD, 'start a planning session', { start: 'plan' }),
  c(
    'task',
    TIMETABLE,
    'I want to plan out the summer timetable',
    { start: 'plan' },
    {
      also: [AGENT],
    },
  ),
  c('board', BOARD, 'have a meeting', { start: 'meeting' }),
  c('board', BOARD, "we're about to talk, take notes for the room", { start: 'meeting' }),
  c('board', BOARD, 'kick off a meeting now', { start: 'meeting' }),
  c('board', BOARD, 'schedule a meeting with Bob for Thursday', AGENT, { near: true }),

  // ── feedback about the app ──
  c('board', BOARD, 'feedback: the mic button is hard to find', FEEDBACK),
  c('board', BOARD, "I'd like to leave feedback that the board feels cluttered", FEEDBACK),
  c(
    'doc',
    BERTH,
    'the comment buttons in this app are too small, pass that on as feedback',
    FEEDBACK,
  ),
  c('board', BOARD, 'leave some feedback', { ask: true }, { also: [FEEDBACK] }),
  c('board', BOARD, 'give Bob feedback on the survey dates', AGENT, { near: true }),

  // ── what voice can do ──
  c('board', BOARD, 'help', HELP),
  c('task', TIMETABLE, 'what can you do', HELP),
  c('mock', MOCK, 'how do I use this', HELP),

  // ── agent requests: the lead's ──
  c('board', BOARD, 'go research ferry fares in Saltmarsh', AGENT),
  c('board', BOARD, 'go update the winter plan with the Sunday sailings', AGENT),
  c('board', BOARD, 'give me a status update', BRIEF, { also: [AGENT] }),
  c('doc', BERTH, 'can you look into why the survey slipped', AGENT),
  c('task', TIMETABLE, 'find out what the council said about the timetable', AGENT),
];
