/**
 * An invented learning-goals doc and two invented working days for the
 * coach, as the signals its stream hears: where-I-am pings from the pages
 * every two minutes while he is active, and activity rows.
 *
 * DRIFTING_DAY wanders twice in ways his goals name: half an hour on a
 * button-hover mock while the launch post is unfinished (goal 1), and a
 * partner's message read and left without a reply (goal 2). ON_TRACK_DAY is
 * the same hours spent on the launch post and the booking spec.
 *
 * LABELLED_POINTS are instants in the drifting day with what a good coach
 * does there, "speak" or "stay quiet". `scripts/coach-eval.ts` asks the
 * real model at each one and counts how many of each it gets right.
 *
 * House names only (Harborlight, Riverbend, Saltmarsh). Agent rows are mixed
 * in so a reader that forgot `isOwner` would see a different day.
 */
import { instantForLocal } from '@claude-workspaces/core/schedule-timezone';
import type { Event } from '../src/activity.ts';
import type { HereSignal } from '../src/coach/stream.ts';

export const ZONE = 'America/Los_Angeles';
export const WS = 'w-harbor';

/** Wednesday 7 October 2026, at `hour:minute` his time. */
export const at = (hour: number, minute = 0): number =>
  instantForLocal(ZONE, 2026, 10, 7, hour, minute);
export const DAY_START = at(8);
export const DAY_END = at(18);

export const GOALS_DOC = `# Learning goals

## Your coach’s name

Let’s call it Saltmarsh.

## Goal 1

### What I want to do better

Do the hard, important work before the easy polish.

### What’s behind it

The Harborlight launch post slips every week while I tidy styles.

### Act differently when

I spend more than twenty minutes on styling or polish while the launch post is unfinished.

### How

Close the styling page and open the launch post draft.

## Goal 2

### What I want to do better

Answer people who are waiting on me the same day.

### What’s behind it

Riverbend partners wait days for a reply.

### Act differently when

I read a message from someone waiting on me and move on without replying.

### How

Reply in two lines before leaving the page.
`;

export const DOCS: Record<string, { title: string; board: string; kind: string }> = {
  'd-post': { title: 'Harborlight launch post draft', board: 'Harborlight', kind: 'markdown' },
  'd-hover': { title: 'Button hover states mock', board: 'Harborlight', kind: 'mockup' },
  'd-partner': {
    title: 'Message from a Riverbend partner, waiting on your answer',
    board: 'Riverbend',
    kind: 'markdown',
  },
  'd-tokens': { title: 'Board colour tokens', board: 'Harborlight', kind: 'markdown' },
  'd-booking': { title: 'Riverbend booking flow spec', board: 'Riverbend', kind: 'markdown' },
  'd-saltmarsh': {
    title: 'Question from a Saltmarsh partner, waiting on your answer',
    board: 'Riverbend',
    kind: 'markdown',
  },
};

export const label = (docId: string) => {
  const d = DOCS[docId];
  return d ? { title: d.title, board: d.board } : {};
};

export type Signal = { at: number } & ({ here: Omit<HereSignal, 'at'> } | { row: Event });

function row(
  type: Event['type'],
  docId: string,
  when: number,
  payload: Event['payload'] = {},
  owner = true,
): Signal {
  const d = DOCS[docId];
  return {
    at: when,
    row: {
      eventId: `ev-${docId}-${when}-${type}`,
      ts: new Date(when).toISOString(),
      type,
      actor: owner ? 'person' : 'agent',
      isOwner: owner,
      doc: {
        docId,
        sourceUrl: null,
        relPath: null,
        title: d?.title ?? docId,
        kind: (d?.kind ?? 'markdown') as Event['doc']['kind'],
        repo: { owner: null, name: null, remote: null },
        producedBy: { agentId: null, sessionId: null, cwd: null },
      },
      payload,
    } as unknown as Event,
  };
}

/** Pings every two minutes on `docId` from `start` for `minutes`, heading
 *  in view and scroll depth moving down the page. */
function stay(docId: string, start: number, minutes: number, heading: string): Signal[] {
  const out: Signal[] = [];
  for (let m = 0; m <= minutes; m += 2) {
    out.push({
      at: start + m * 60_000,
      here: {
        workspaceId: WS,
        docId,
        visible: true,
        scrollPct: Math.min(100, Math.round((m / minutes) * 100)),
        heading,
      },
    });
  }
  return out;
}

const away = (when: number): Signal => ({
  at: when,
  here: { workspaceId: WS, docId: 'd-post', visible: false },
});

const byTime = (xs: Signal[]) => xs.sort((a, b) => a.at - b.at);

export const DRIFTING_DAY: Signal[] = byTime([
  ...stay('d-post', at(9), 40, 'Why we built it'),
  row('edit_session', 'd-post', at(9, 30), { editCount: 14 }),
  ...stay('d-hover', at(9, 41), 49, 'Hover, pressed, focus'),
  row('comment', 'd-hover', at(10, 12), { text: 'Try a softer shadow on hover, and a 2px lift.' }),
  ...stay('d-partner', at(10, 31), 12, 'Can we move the launch?'),
  ...stay('d-tokens', at(10, 44), 14, 'Greys'),
  row('edit_session', 'd-booking', at(10, 20), { editCount: 40 }, false),
  away(at(10, 59)),
  ...stay('d-booking', at(11), 40, 'Payment step'),
  row('edit_session', 'd-booking', at(11, 25), { editCount: 9 }),
  away(at(11, 41)),
  ...stay('d-post', at(13), 30, 'What it costs'),
  row('edit_session', 'd-post', at(13, 20), { editCount: 22 }),
  ...stay('d-saltmarsh', at(13, 31), 18, 'Pricing question'),
  row('reply', 'd-saltmarsh', at(13, 48), {
    text: 'Yes, the Saltmarsh price holds until December.',
  }),
  away(at(13, 50)),
]);

export const ON_TRACK_DAY: Signal[] = byTime([
  ...stay('d-post', at(9), 90, 'Why we built it'),
  row('edit_session', 'd-post', at(9, 30), { editCount: 14 }),
  row('edit_session', 'd-post', at(10, 15), { editCount: 30 }),
  away(at(10, 31)),
  ...stay('d-booking', at(11), 40, 'Payment step'),
  row('edit_session', 'd-booking', at(11, 25), { editCount: 9 }),
  away(at(11, 41)),
  ...stay('d-post', at(13), 50, 'What it costs'),
  row('edit_session', 'd-post', at(13, 20), { editCount: 22 }),
  away(at(13, 51)),
]);

export interface LabelledPoint {
  at: number;
  expect: 'speak' | 'quiet';
  /** 0-based, for a "speak" point. */
  goalIndex?: number;
  why: string;
}

export const LABELLED_POINTS: LabelledPoint[] = [
  { at: at(9, 30), expect: 'quiet', why: 'half an hour into the launch post itself' },
  {
    at: at(9, 50),
    expect: 'quiet',
    why: 'nine minutes on the hover mock: under the twenty he named',
  },
  {
    at: at(10, 10),
    expect: 'speak',
    goalIndex: 0,
    why: 'half an hour on hover states, post unfinished',
  },
  {
    at: at(10, 50),
    expect: 'speak',
    goalIndex: 1,
    why: 'read the partner’s message and moved on without replying',
  },
  {
    at: at(11, 30),
    expect: 'quiet',
    why: 'half an hour on the booking spec, which no trigger names',
  },
  { at: at(13, 25), expect: 'quiet', why: 'back on the launch post' },
  { at: at(13, 49), expect: 'quiet', why: 'read the Saltmarsh question and replied' },
];
