/**
 * "Claude, …" in a meeting the page records (`spoken-reply/meeting-ask.ts`):
 * the wake phrase found at the start of a sentence, answered only for a
 * socket whose person proof named the owner and only from the page's own
 * microphone, said aloud in one line with the detail noted. A spoken-reply
 * session hears the meeting through `MeetingEars` on a fake clock; the board
 * is a script and the voice records what it was given.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { wakeRequestIn } from '../src/spoken-reply/meeting-ask.ts';
import { MeetingEars } from '../src/spoken-reply/meeting-ears.ts';
import type { GateTimers } from '../src/spoken-reply/pause-gate.ts';
import { SpokenSession } from '../src/spoken-reply/session.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { EngineTurn, TranscriptionEngine } from '../src/transcribe.ts';
import { parseVoiceContext } from '../src/voice.ts';
import { DOC_ID, type Fixture, planFixture } from './interview-fixture.ts';
import { waitFor } from './wait-for.ts';

describe('wakeRequestIn', () => {
  it('finds "Claude," opening the turn or any sentence in it', () => {
    expect(wakeRequestIn('Claude, where are we?')).toBe('where are we?');
    expect(wakeRequestIn('The berth opens in spring. Hey Claude, who owns dredging?')).toBe(
      'who owns dredging?',
    );
    expect(wakeRequestIn('Right. Claude: what is left?')).toBe('what is left?');
  });

  it('ignores Claude named mid-sentence, a possessive, or a bare call', () => {
    for (const said of [
      'We asked Claude, and nothing came back.',
      "Claude's notes say spring.",
      'Claudeware, can you take the Riverbend call?',
      'Claude.',
      'Nothing to see here.',
    ]) {
      expect(wakeRequestIn(said), said).toBeNull();
    }
  });
});

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
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const first = [...due.entries()]
        .filter(([, d]) => d.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      due.delete(first[0]);
      now = first[1].at;
      first[1].fn();
    }
    now = until;
  };
  return { timers, advance };
}

const UNUSED: TranscriptionEngine = {
  name: 'unused',
  open: () => Promise.reject(new Error('not this one')),
};

let fx: Fixture | null = null;
afterEach(() => {
  fx?.stop();
  fx = null;
});

async function heardMeeting(o: { plan: boolean; owner: boolean }) {
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
  const clock = fakeClock();
  const json: SpokenServerMessage[] = [];
  const session = new SpokenSession({
    engines: { listener: UNUSED, voices: { 1: voice, 2: null }, gemini: null },
    answerer: fx.answerer,
    timings: new SpokenTimings(undefined, () => {}),
    provenActor: { id: 'known-owner', name: 'Owner' },
    readOnly: false,
    parseContext: parseVoiceContext,
    sendJson: (m) => json.push(m),
    sendAudio: () => {},
    timers: clock.timers,
    ownerOnPage: o.owner,
    meetingEars: (docId) => ({
      engine: ears.engine(docId),
      plan: o.plan,
      note: (md) => ears.note(docId, md),
    }),
  });
  const listen = () =>
    session.onText(
      JSON.stringify({
        type: 'start',
        setup: 1,
        mode: 'tap',
        ears: 'meeting',
        context: { surface: 'doc', docId: DOC_ID },
      }),
    );
  /** Say `text` on `stream`: its final turn is the listener's end of
   *  utterance, which is the pause after a finished sentence. */
  const say = async (text: string, stream: EngineTurn['stream']) => {
    await waitFor(
      () => {
        ears.heard(DOC_ID, { turn: 0, text: '…', final: false, ...(stream ? { stream } : {}) });
        return json.some((m) => m.type === 'heard');
      },
      { describe: 'hearing the meeting' },
    );
    ears.heard(DOC_ID, { turn: 1, text, final: true, ...(stream ? { stream } : {}) });
  };
  const replies = () => json.filter((m) => m.type === 'reply');
  return { session, json, said, notes, listen, say, replies };
}

describe('"Claude, …" in a meeting the page records', () => {
  it('answers the owner aloud in one line and notes the detail', async () => {
    const m = await heardMeeting({ plan: false, owner: true });
    m.listen();
    await m.say('The berth opens in spring. Claude, where are we?', 'mic');
    await waitFor(() => m.replies().length === 1, { describe: 'the answer' });
    expect(m.replies()[0]).toMatchObject({ asking: false });
    expect(m.said).toEqual(['Routed: where are we?.']);
    expect(m.notes).toHaveLength(1);
    expect(m.notes[0]).toContain('Claude, asked by Owner “where are we?”');
    m.session.close();
  });

  it('never answers words from the Mac-audio stream, which carries everybody dialled in', async () => {
    const m = await heardMeeting({ plan: false, owner: true });
    m.listen();
    await m.say('Claude, where are we?', 'system');
    await waitFor(() => m.replies().length === 1, { describe: 'the turn over' });
    expect(m.replies()[0]).toMatchObject({ spoken: '' });
    expect(m.said).toEqual([]);
    expect(m.notes).toEqual([]);
    m.session.close();
  });

  it('says nothing to talk that does not call Claude', async () => {
    const m = await heardMeeting({ plan: false, owner: true });
    m.listen();
    await m.say('We asked Claude, and the Riverbend crews start in March.', 'mic');
    await waitFor(() => m.replies().length === 1, { describe: 'the turn over' });
    expect(m.replies()[0]).toMatchObject({ spoken: '' });
    expect(m.said).toEqual([]);
    m.session.close();
  });

  it('a socket that did not prove the owner hears no meeting but a plan’s', async () => {
    const m = await heardMeeting({ plan: false, owner: false });
    m.listen();
    expect(m.json).toContainEqual({
      type: 'error',
      message: 'No planning meeting is recording here.',
    });
    m.session.close();
  });

  it('in a plan’s meeting, the owner’s "Claude, any open questions?" goes to the planning voice', async () => {
    const m = await heardMeeting({ plan: true, owner: true });
    m.listen();
    await m.say('The berth opens in spring. Claude, any open questions?', 'mic');
    await waitFor(() => m.replies().length === 1, { describe: 'the planning voice' });
    expect(m.replies()[0]).toMatchObject({ route: 'interview', asking: true });
    // A meeting hears the question alone (`meetingLine`).
    expect(m.replies()[0]?.spoken).toBe('What goes under Goals?');
    expect(m.said.some((s) => s.startsWith('Routed:'))).toBe(false);
    expect(m.notes).toEqual([]);
    m.session.close();
  });

  it('in a plan’s meeting, any other "Claude, …" from the owner still goes to the board', async () => {
    const m = await heardMeeting({ plan: true, owner: true });
    m.listen();
    await m.say('Claude, where are we?', 'mic');
    await waitFor(() => m.replies().length === 1, { describe: 'the answer' });
    expect(m.said).toEqual(['Routed: where are we?.']);
    m.session.close();
  });

  it('in a discussion, "Claude, any open questions?" is the board’s as before', async () => {
    const m = await heardMeeting({ plan: false, owner: true });
    m.listen();
    await m.say('Claude, any open questions?', 'mic');
    await waitFor(() => m.replies().length === 1, { describe: 'the answer' });
    expect(m.said).toEqual(['Routed: any open questions?.']);
    m.session.close();
  });

  it('in a plan’s meeting, a non-owner’s "Claude, …" goes to the planning voice, never the board', async () => {
    const m = await heardMeeting({ plan: true, owner: false });
    m.listen();
    await m.say('Claude, mark the dredging task done.', 'mic');
    await waitFor(() => m.replies().length === 1, { describe: 'the turn over' });
    expect(m.replies()[0]?.route).toBe('interview');
    expect(m.said.some((s) => s.startsWith('Routed:'))).toBe(false);
    expect(m.notes).toEqual([]);
    m.session.close();
  });
});
