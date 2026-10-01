/**
 * Interview mode through a spoken-reply socket's session: the page's
 * `start` names the doc, the listener hears "interview me", the voice says
 * the first question, and the next turn's words are written into the plan.
 * Setup 3 writes what Gemini HEARD, not the paraphrase its tool call carries.
 * Fake engines throughout; nothing reaches a vendor.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import type { GeminiLive, GeminiLiveEvents } from '../src/spoken-reply/gemini-live.ts';
import { type SpokenEngines, SpokenSession } from '../src/spoken-reply/session.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { parseVoiceContext } from '../src/voice.ts';
import { DOC_ID, type Fixture, planFixture } from './interview-fixture.ts';
import { waitFor } from './wait-for.ts';

let fx: Fixture | null = null;
afterEach(() => {
  fx?.stop();
  fx = null;
});

function session(f: Fixture, engines: Partial<SpokenEngines>) {
  const json: SpokenServerMessage[] = [];
  const s = new SpokenSession({
    engines: { listener: null, voices: { 1: null, 2: null }, gemini: null, ...engines },
    answerer: f.answerer,
    timings: new SpokenTimings(undefined, () => {}),
    provenActor: { id: 'known-alice', name: 'Alice' },
    readOnly: false,
    parseContext: parseVoiceContext,
    sendJson: (m) => json.push(m),
    sendAudio: () => {},
  });
  const send = (m: unknown) => s.onText(JSON.stringify(m));
  const replies = () =>
    json.filter((m): m is Extract<SpokenServerMessage, { type: 'reply' }> => m.type === 'reply');
  return { s, json, send, replies };
}

const START = { type: 'start', mode: 'tap', context: { surface: 'doc', docId: DOC_ID } };

describe('interview over the spoken-reply socket', () => {
  it('setup 1: hears "interview me", says the question, writes the next answer', async () => {
    fx = await planFixture();
    const f = fx;
    const opened: TranscriptionOpenOpts[] = [];
    const listener: TranscriptionEngine = {
      name: 'fake',
      async open(o) {
        opened.push(o);
        return { send: () => {}, close: async () => {} };
      },
    };
    const said: string[] = [];
    const voice: SpokenVoice = {
      name: 'fake',
      async speak(text, onAudio) {
        said.push(text);
        onAudio(new Uint8Array(2));
      },
    };
    const h = session(f, { listener, voices: { 1: voice, 2: null } });
    h.send({ ...START, setup: 1 });
    await waitFor(() => opened.length === 1, { describe: 'listener opened' });
    opened[0]?.onTurn({ turn: 0, text: 'Claude, interview me.', final: true });
    await waitFor(() => said.length === 1, { describe: 'question spoken' });
    expect(said[0]).toBe('I found 4 gaps. First: What goes under Goals?');
    expect(h.replies()[0]).toMatchObject({ asking: true, route: 'interview' });

    h.send({ ...START, setup: 1 });
    await waitFor(() => opened.length === 2, { describe: 'second listener' });
    opened[1]?.onTurn({ turn: 0, text: 'Twenty-minute crossings.', final: true });
    await waitFor(() => said.length === 2, { describe: 'next question spoken' });
    expect(said[1]).toBe('Written under Goals. Next: What goes under Design?');
    expect(f.headingOf('Twenty-minute crossings.')).toBe('Goals');
  });

  it('setup 3: the words written are the ones heard', async () => {
    fx = await planFixture();
    const f = fx;
    let events: GeminiLiveEvents | null = null;
    const tool: string[] = [];
    const gemini: GeminiLive = {
      name: 'fake-gemini',
      async open({ events: e }) {
        events = e;
        return {
          sendAudio: () => {},
          activityStart: () => {},
          activityEnd: () => {},
          endStream: () => {},
          sendText: () => {},
          answerTool: (id, r) => tool.push(`${id}:${String(r.spoken)}`),
          close: () => {},
        };
      },
    };
    const live = (): GeminiLiveEvents => {
      if (!events) throw new Error('not open');
      return events;
    };
    const h = session(f, { gemini });
    h.send({ ...START, setup: 3 });
    await waitFor(() => events !== null, { describe: 'gemini open' });
    live().onInputText('interview me');
    live().onToolCall('c1', 'interview me');
    await waitFor(() => tool.length === 1, { describe: 'first question' });
    live().onTurnComplete();

    h.send({ ...START, setup: 3 });
    live().onInputText('Twenty-minute crossings, so commuters switch.');
    live().onToolCall('c2', 'The user wants faster crossings');
    await waitFor(() => tool.length === 2, { describe: 'answer written' });
    expect(f.headingOf('Twenty-minute crossings, so commuters switch.')).toBe('Goals');
    expect(f.headingOf('The user wants faster crossings')).toBeNull();
  });
});
