/**
 * Two invented working weeks for the goal coach, as `activity.jsonl` rows.
 *
 * Both weeks share the goals and Monday, Tuesday and Thursday, which are
 * spent on them. They differ on Wednesday:
 *
 *  - ON_TRACK: the morning on the launch post, the afternoon on the booking
 *    flow spec, a short look at a colour mock.
 *  - DRIFTING: an hour on the launch post, then the rest of the day on board
 *    colour tokens, a button-hover mock and font experiments, none of which
 *    serves a goal.
 *
 * House names only (Harborlight, Riverbend, Saltmarsh). Agent rows are mixed
 * in so a reader that forgot `isOwner` would see a different week. Shared
 * by `coach-pass.test.ts` and `scripts/coach-eval.ts`, which runs the same
 * weeks through the real model.
 */
import { instantForLocal } from '@claude-workspaces/core/schedule-timezone';

export const ZONE = 'America/Los_Angeles';
export const GOALS = [
  'Publish the Harborlight launch post',
  'Ship the Riverbend booking flow',
  'Reply to the Saltmarsh partners',
];

/** 5 October 2026 is a Monday. */
export const at = (day: number, hour: number, minute = 0): number =>
  instantForLocal(ZONE, 2026, 10, 5 + day, hour, minute);
export const WEEK_START = at(0, 0);
export const WEEK_END = at(5, 0);

interface Row {
  ts: string;
  type: string;
  actor: 'person' | 'agent';
  isOwner: boolean;
  doc: { docId: string; title: string; kind: string };
  payload: Record<string, unknown>;
}

const DOCS = {
  post: { docId: 'd-post', title: 'Harborlight launch post draft', kind: 'markdown' },
  booking: { docId: 'd-booking', title: 'Riverbend booking flow spec', kind: 'markdown' },
  bookingMock: { docId: 'd-book-mock', title: 'Riverbend booking flow mock', kind: 'mockup' },
  partners: { docId: 'task:t-partners', title: 'Saltmarsh partner replies', kind: 'markdown' },
  tokens: { docId: 'd-tokens', title: 'Board colour tokens', kind: 'markdown' },
  hover: { docId: 'd-hover', title: 'Button hover states mock', kind: 'mockup' },
  fonts: { docId: 'd-fonts', title: 'Font size experiments', kind: 'mockup' },
} as const;
type DocKey = keyof typeof DOCS;

/** `minutes` of reading, in 20-minute sessions, starting at `start`. */
function reading(doc: DocKey, start: number, minutes: number, owner = true): Row[] {
  const rows: Row[] = [];
  for (let m = 0; m < minutes; m += 20) {
    const span = Math.min(20, minutes - m);
    rows.push({
      ts: new Date(start + (m + span) * 60_000).toISOString(),
      type: 'read_session',
      actor: owner ? 'person' : 'agent',
      isOwner: owner,
      doc: DOCS[doc],
      payload: { durationMs: span * 60_000 },
    });
  }
  return rows;
}

function edit(doc: DocKey, when: number): Row {
  return {
    ts: new Date(when).toISOString(),
    type: 'edit_session',
    actor: 'person',
    isOwner: true,
    doc: DOCS[doc],
    payload: { source: 'editor', editCount: 12 },
  };
}

function comment(doc: DocKey, when: number, text: string): Row {
  return {
    ts: new Date(when).toISOString(),
    type: 'comment',
    actor: 'person',
    isOwner: true,
    doc: DOCS[doc],
    payload: { text },
  };
}

/** A day spent on the goals: the post, the booking flow, the partners. */
function goalDay(day: number): Row[] {
  return [
    ...reading('post', at(day, 9), 100),
    edit('post', at(day, 10, 45)),
    comment('post', at(day, 11), 'Tighten the opening and move the pricing note down.'),
    ...reading('booking', at(day, 13), 80),
    ...reading('bookingMock', at(day, 14, 30), 40),
    comment('bookingMock', at(day, 15, 15), 'The confirm step needs the date on it.'),
    ...reading('partners', at(day, 16), 30),
    comment('partners', at(day, 16, 30), 'Sent Alice the revised terms; waiting on Bob.'),
    // An agent's afternoon on the colour tokens is not Bryan's.
    ...reading('tokens', at(day, 13), 120, false),
  ];
}

const onTrackWednesday = (): Row[] => [
  ...reading('post', at(2, 9), 140),
  edit('post', at(2, 11, 30)),
  ...reading('booking', at(2, 13), 120),
  edit('booking', at(2, 14, 50)),
  ...reading('tokens', at(2, 15, 30), 15),
  ...reading('partners', at(2, 16), 30),
];

const driftingWednesday = (): Row[] => [
  ...reading('post', at(2, 9), 60),
  ...reading('tokens', at(2, 10, 30), 100),
  edit('tokens', at(2, 12, 15)),
  ...reading('hover', at(2, 13), 120),
  comment('hover', at(2, 14, 30), 'Try a softer shadow on hover, and a 2px lift.'),
  ...reading('fonts', at(2, 15), 140),
  edit('fonts', at(2, 17, 15)),
];

const week = (wednesday: () => Row[]): Row[] =>
  [goalDay(0), goalDay(1), wednesday(), goalDay(3), goalDay(4)]
    .flat()
    .sort((a, b) => a.ts.localeCompare(b.ts));

export const ON_TRACK_WEEK = week(onTrackWednesday);
export const DRIFTING_WEEK = week(driftingWednesday);
