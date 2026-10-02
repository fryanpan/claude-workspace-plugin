/**
 * "Claude, …" in a meeting, when the board hands it to the lead: the voice
 * says "On it.", the page is told what Claude is working on in a few words
 * (`doing`), and the lead's answer is written into the notes at once and
 * said in one sentence at the next pause — never over the meeting. A
 * spoken-reply session hears the meeting through `MeetingEars` on a fake
 * clock; the board is a script and the voice records what it was given.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { SpokenAnswerer, type SpokenBoard, shapedAnswer } from '../src/spoken-reply/answer.ts';
import { LEAD_ANSWER_ROUTE } from '../src/spoken-reply/lead-answer.ts';
import { MeetingEars } from '../src/spoken-reply/meeting-ears.ts';
import { doingLabel } from '../src/spoken-reply/meeting-errands.ts';
import type { GateTimers } from '../src/spoken-reply/pause-gate.ts';
import { SpokenSession } from '../src/spoken-reply/session.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../src/transcribe.ts';
import { parseVoiceContext } from '../src/voice.ts';
import { DOC_ID, type Fixture, WS, planFixture } from './interview-fixture.ts';
import { waitFor } from './wait-for.ts';

describe('doingLabel', () => {
  it('is the request’s first four words, less the asking', () => {
    expect(doingLabel('can you find the Riverbend ferry fares for spring?')).toBe(
      'find the Riverbend ferry',
    );
    expect(doingLabel('please draft the Saltmarsh berth notice.')).toBe(
      'draft the Saltmarsh berth',
    );
    expect(doingLabel('could you go and check the tide tables')).toBe('check the tide tables');
    expect(doingLabel('summarize.')).toBe('summarize');
    expect(doingLabel('please')).toBe('please');
  });
});

const UNUSED: TranscriptionEngine = {
  name: 'unused',
  open: () => Promise.reject(new Error('not this one')),
};

/** The board hands every request to the lead, as research does. */
const TO_LEAD: SpokenBoard = {
  async handle() {
    return { ok: true, route: 'agent-queued' as const, ack: 'On it.', queueId: 'q-fares' };
  },
  goalStatus: () => undefined,
  goals: () => [],
};

const FARES = 'Fares are four dollars for Riverbend riders. Children under twelve ride free.';

let fx: Fixture | null = null;
afterEach(() => {
  fx?.stop();
  fx = null;
});

async function meeting() {
  fx = await planFixture();
  const ears = new MeetingEars();
  const notes: string[] = [];
  ears.started(DOC_ID, (md) => notes.push(md));
  const said: string[] = [];
  const voice: SpokenVoice = {
    name: 'recorded',
    async speak(text, onAudio) {
      said.push(text);
      onAudio(new Uint8Array(480));
    },
  };
  const timers: GateTimers = { set: () => 0, clear: () => {} };
  const json: SpokenServerMessage[] = [];
  const session = new SpokenSession({
    engines: { listener: UNUSED, voices: { 1: voice, 2: null }, gemini: null },
    answerer: new SpokenAnswerer(TO_LEAD, WS, fx.interview),
    timings: new SpokenTimings(undefined, () => {}),
    provenActor: { id: 'known-owner', name: 'Owner' },
    readOnly: false,
    parseContext: parseVoiceContext,
    sendJson: (m) => json.push(m),
    sendAudio: () => {},
    timers,
    ownerOnPage: true,
    meetingEars: (docId) => ({
      engine: ears.engine(docId),
      plan: false,
      note: (md) => ears.note(docId, md),
    }),
  });
  let turn = 0;
  /** The page listens again, as it does after every reply; `probe` waits
   *  until a word of the meeting is heard, and is itself a word heard. */
  const listen = async (probe = true) => {
    const before = json.filter((m) => m.type === 'heard').length;
    session.onText(
      JSON.stringify({
        type: 'start',
        setup: 1,
        mode: 'tap',
        ears: 'meeting',
        context: { surface: 'doc', docId: DOC_ID },
      }),
    );
    if (!probe) return;
    await waitFor(
      () => {
        ears.heard(DOC_ID, { turn: ++turn, text: 'Mm', final: false, stream: 'mic' });
        return json.filter((m) => m.type === 'heard').length > before;
      },
      { describe: 'hearing the meeting' },
    );
  };
  const hear = (text: string, final: boolean) =>
    ears.heard(DOC_ID, { turn: ++turn, text, final, stream: 'mic' });
  const doing = () =>
    json.flatMap((m) => (m.type === 'doing' ? [m.label] : [])) as Array<string | null>;
  const replies = () => json.filter((m) => m.type === 'reply');
  return { session, json, said, notes, listen, hear, doing, replies };
}

describe('"Claude, …" handed to the lead in a meeting', () => {
  it('says On it, shows what it is doing, then notes the answer and says it at the next pause', async () => {
    const m = await meeting();
    await m.listen();
    m.hear('Claude, can you find the Riverbend ferry fares for spring?', true);
    await waitFor(() => m.said.length === 1, { describe: 'On it' });
    expect(m.said).toEqual(['On it.']);
    expect(m.doing()).toEqual(['find the Riverbend ferry']);
    // "On it." is not an answer: nothing is noted yet.
    expect(m.notes).toEqual([]);

    // The meeting goes on, and the lead answers mid-sentence.
    await m.listen();
    m.hear('The berth opens in', false);
    m.session.sayLead('q-fares', shapedAnswer(FARES, LEAD_ANSWER_ROUTE));
    expect(m.notes).toHaveLength(1);
    expect(m.notes[0]).toContain('find the Riverbend ferry fares for spring?');
    expect(m.notes[0]).toContain('Children under twelve ride free.');
    expect(m.doing()).toEqual(['find the Riverbend ferry', null]);
    // Not over the speaker.
    expect(m.said).toEqual(['On it.']);

    // The next pause: one sentence.
    m.hear('The berth opens in spring.', true);
    await waitFor(() => m.said.length === 2, { describe: 'the answer at the pause' });
    expect(m.said[1]).toBe('Fares are four dollars for Riverbend riders.');
    m.session.close();
  });

  it('says the answer at once when the meeting is quiet', async () => {
    const m = await meeting();
    await m.listen();
    m.hear('Claude, draft the Saltmarsh berth notice.', true);
    await waitFor(() => m.said.length === 1, { describe: 'On it' });
    await m.listen(false);
    m.json.length = 0;
    m.session.sayLead('q-fares', shapedAnswer(FARES, LEAD_ANSWER_ROUTE));
    await waitFor(() => m.said.length === 2, { describe: 'the answer said' });
    expect(m.said[1]).toBe('Fares are four dollars for Riverbend riders.');
    expect(m.doing()).toEqual([null]);
    m.session.close();
  });

  it('an answer from outside a meeting is said as before', async () => {
    const m = await meeting();
    m.session.sayLead('q-elsewhere', shapedAnswer(FARES, LEAD_ANSWER_ROUTE));
    await waitFor(() => m.said.length === 1, { describe: 'the aside' });
    expect(m.notes).toEqual([]);
    expect(m.doing()).toEqual([]);
    m.session.close();
  });
});
