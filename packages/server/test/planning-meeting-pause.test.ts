/**
 * In a planning meeting the question waits for a pause, never a breath: a
 * spoken-reply session hearing the meeting through `MeetingEars`, on a fake
 * clock, with a sentence left hanging on "and", and the page's own pause
 * setting taken from its `start` or changed while it runs. The model is a script and the voice is
 * mute.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { MeetingEars } from '../src/spoken-reply/meeting-ears.ts';
import {
  FINISHED_PAUSE_MS,
  type GateTimers,
  UNFINISHED_PAUSE_MS,
} from '../src/spoken-reply/pause-gate.ts';
import { SpokenSession } from '../src/spoken-reply/session.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../src/transcribe.ts';
import { parseVoiceContext } from '../src/voice.ts';
import { DOC_ID, type Fixture, planFixture } from './interview-fixture.ts';
import { waitFor } from './wait-for.ts';

const BERTH_PLAN = `# Harborlight berth plan

## Goal

Open the second Harborlight berth to Riverbend ferries by spring.

### Work

- Dredge the Saltmarsh channel to four metres before March.
- Move the ticket office to the new pier.
`;

function fakeClock() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: GateTimers = {
    set: (fn, ms) => {
      const id = ++next;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (h) => void due.delete(h as number),
  };
  const advanceTo = (t: number) => {
    for (;;) {
      const first = [...due.entries()]
        .filter(([, d]) => d.at <= t)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      due.delete(first[0]);
      now = first[1].at;
      first[1].fn();
    }
    now = t;
  };
  return { timers, advanceTo };
}

const MUTE: SpokenVoice = { name: 'mute', async speak() {} };
/** Setup 1 is offered only with its own listener; the meeting stands in for it. */
const UNUSED: TranscriptionEngine = {
  name: 'unused',
  open: () => Promise.reject(new Error('not this one')),
};

let fx: Fixture | null = null;
afterEach(() => {
  fx?.stop();
  fx = null;
});

describe('a planning meeting’s question waits for the pause', () => {
  async function meeting(pause?: { finishedMs: number; unfinishedMs: number }) {
    const calls: string[] = [];
    const ears = new MeetingEars();
    fx = await planFixture({
      markdown: BERTH_PLAN,
      ears,
      complete: async ({ user }) => {
        calls.push(user);
        return JSON.stringify({ ask: 'Who signs off the dredging?', heading: 'Work' });
      },
    });
    ears.started(DOC_ID);
    const clock = fakeClock();
    const json: SpokenServerMessage[] = [];
    const s = new SpokenSession({
      engines: { listener: UNUSED, voices: { 1: MUTE, 2: null }, gemini: null },
      answerer: fx.answerer,
      timings: new SpokenTimings(undefined, () => {}),
      provenActor: null,
      readOnly: false,
      parseContext: parseVoiceContext,
      sendJson: (m) => json.push(m),
      sendAudio: () => {},
      timers: clock.timers,
      meetingEars: (docId) => ({ engine: ears.engine(docId), plan: true, note: () => {} }),
    });
    s.onText(
      JSON.stringify({
        type: 'start',
        setup: 1,
        mode: 'tap',
        ears: 'meeting',
        context: { surface: 'doc', docId: DOC_ID },
        ...(pause ? { pause } : {}),
      }),
    );
    const replies = () => json.filter((m) => m.type === 'reply');
    // The listener is the meeting's: opened once the start is handled.
    await waitFor(
      () => {
        ears.heard(DOC_ID, { turn: 0, text: 'We', final: false });
        return json.some((m) => m.type === 'heard');
      },
      { describe: 'hearing the meeting' },
    );
    const hear = (turn: number, text: string, final: boolean) =>
      ears.heard(DOC_ID, { turn, text, final });
    return { s, clock, json, calls, replies, hear };
  }

  it('nothing while the sentence hangs, one question once it has held as a pause', async () => {
    const m = await meeting();
    m.hear(0, 'We dredge the Saltmarsh channel first and', true);
    m.clock.advanceTo(UNFINISHED_PAUSE_MS - 1);
    expect(m.replies()).toEqual([]);
    expect(m.calls).toEqual([]);
    // More words inside the window: still the same sentence.
    m.hear(1, 'then', false);
    m.hear(1, 'then move the office.', false);
    m.clock.advanceTo(UNFINISHED_PAUSE_MS - 1 + FINISHED_PAUSE_MS - 1);
    expect(m.replies()).toEqual([]);
    // 1.5s with nothing new after a finished sentence, before its endpoint.
    m.clock.advanceTo(UNFINISHED_PAUSE_MS - 1 + FINISHED_PAUSE_MS);
    await waitFor(() => m.replies().length === 1, { describe: 'the question at the pause' });
    expect(m.replies()[0]).toMatchObject({ spoken: 'Who signs off the dredging?', asking: true });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toContain('We dredge the Saltmarsh channel first and then move the office.');
    // That turn's final, arriving late, repeats words already heard: no cut-in.
    m.hear(1, 'then move the office.', true);
    expect(m.json.filter((x) => x.type === 'cut-in')).toEqual([]);
    m.s.close();
  });

  it('waits as long as the page’s pause setting says', async () => {
    const m = await meeting({ finishedMs: 4000, unfinishedMs: 7000 });
    m.hear(0, 'We dredge the Saltmarsh channel first and', true);
    m.clock.advanceTo(6999);
    expect(m.calls).toEqual([]);
    m.hear(1, 'then move the office.', false);
    m.clock.advanceTo(6999 + 3999);
    expect(m.calls).toEqual([]);
    m.clock.advanceTo(6999 + 4000);
    await waitFor(() => m.replies().length === 1, { describe: 'the question at the set pause' });
    m.s.close();
  });

  it('a setting changed mid-meeting times the next wait, without a new start', async () => {
    const m = await meeting();
    m.s.onText(JSON.stringify({ type: 'pause', pause: { finishedMs: 2500, unfinishedMs: 6000 } }));
    m.hear(0, 'We dredge the Saltmarsh channel first —', false);
    m.clock.advanceTo(5999);
    expect(m.calls).toEqual([]);
    m.clock.advanceTo(6000);
    await waitFor(() => m.replies().length === 1, { describe: 'the question at the new pause' });
    m.s.close();
  });

  it('a socket that asks to hear a meeting with none recording is told so', async () => {
    fx = await planFixture({ markdown: BERTH_PLAN });
    const json: SpokenServerMessage[] = [];
    const s = new SpokenSession({
      engines: { listener: UNUSED, voices: { 1: MUTE, 2: null }, gemini: null },
      answerer: fx.answerer,
      timings: new SpokenTimings(undefined, () => {}),
      provenActor: null,
      readOnly: false,
      parseContext: parseVoiceContext,
      sendJson: (m) => json.push(m),
      sendAudio: () => {},
      meetingEars: () => null,
    });
    s.onText(
      JSON.stringify({
        type: 'start',
        setup: 1,
        mode: 'tap',
        ears: 'meeting',
        context: { surface: 'doc', docId: DOC_ID },
      }),
    );
    expect(json).toContainEqual({
      type: 'error',
      message: 'No planning meeting is recording here.',
    });
    s.close();
  });
});
