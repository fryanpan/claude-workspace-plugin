/**
 * A spoken point's note: which points earn one, what it says, and — the
 * point of the feature — that it reaches the page no later than the first
 * audio of the point it records, in every setup.
 *
 * The order proof drives a whole `SpokenSession` with stubbed engines and
 * reads ONE log of everything it sent, JSON and audio interleaved as the
 * socket would carry them. Each stubbed voice stamps its audio with the
 * point it is saying, so the log says which point every audio frame is for.
 */
import { describe, expect, it } from 'bun:test';
import type { SpokenPoint, SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { SpokenAnswerer, type SpokenBoard } from '../src/spoken-reply/answer.ts';
import type { GeminiLive, GeminiLiveEvents } from '../src/spoken-reply/gemini-live.ts';
import { noteFor, withNotes } from '../src/spoken-reply/notes.ts';
import { type SpokenEngines, SpokenSession } from '../src/spoken-reply/session.ts';
import { speakPoints } from '../src/spoken-reply/speak-points.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine, TranscriptionOpenOpts } from '../src/transcribe.ts';
import { waitFor } from './wait-for.ts';

const BRIEF =
  'Heard: "where are we". Harborlight: 4 open — 2 in progress, 2 to do, 1 done. In progress: “Riverbend import”. Waiting on you: 2 — “pick a name” on “Saltmarsh”; “approve the mock” on “Sign-in”. Done recently: “the import fix”.';

describe('noteFor', () => {
  const brief = { route: 'fast-path', first: false };

  it('notes what is waiting on you, in written wording', () => {
    expect(noteFor('Waiting on you: 2 — “a” on “b”; “c” on “d”.', brief)).toBe(
      'Waiting on you (2): “a” on “b”; “c” on “d”',
    );
    expect(noteFor('Waiting on you: “sign off”.', brief)).toBe('Waiting on you: “sign off”');
    expect(noteFor('“Plan”: 2 waiting on you — “a” (Bob); “b” (Alice).', brief)).toBe(
      '“Plan”, waiting on you (2): “a” (Bob); “b” (Alice)',
    );
    expect(noteFor('“Sign-in” is in progress, with Bob, needs a review.', brief)).toBe(
      '“Sign-in” needs a review (in progress, with Bob)',
    );
  });

  it('notes a change the board just made, and only in its first point', () => {
    const act = { route: 'fast-path-action', first: true };
    expect(noteFor('Moved "Sign-in" from todo to done.', act)).toBe('“Sign-in”: todo → done');
    expect(noteFor('Assigned "Sign-in" to Bob.', act)).toBe('“Sign-in” assigned to Bob');
    expect(noteFor('"Sign-in" is already done.', act)).toBeUndefined();
    expect(noteFor('Moved "Sign-in" from todo to done.', { ...act, first: false })).toBeUndefined();
  });

  it('says without noting: counts, nothing waiting, questions, hand-offs', () => {
    expect(noteFor('Harborlight: 4 open — 2 in progress.', brief)).toBeUndefined();
    expect(noteFor('Nothing waiting on you.', brief)).toBeUndefined();
    expect(noteFor('Which goal: A or B?', brief)).toBeUndefined();
    expect(noteFor('Sent to the lead agent.', { route: 'agent', first: true })).toBeUndefined();
  });
});

describe('the answer carries its points', () => {
  it('the brief speaks two points and notes the one waiting on you', async () => {
    const board: SpokenBoard = {
      handle: async () => ({ ok: true, route: 'fast-path', ack: BRIEF }),
      goalStatus: () => undefined,
      goals: () => [],
    };
    const a = await new SpokenAnswerer(board, 'w1').answer('where are we', ACTOR, undefined);
    expect(a.points).toEqual([
      { say: 'Harborlight: 4 open — 2 in progress, 2 to do, 1 done.' },
      {
        say: 'Waiting on you: 2 — “pick a name” on “Saltmarsh”; “approve the mock” on “Sign-in”.',
        note: 'Waiting on you (2): “pick a name” on “Saltmarsh”; “approve the mock” on “Sign-in”',
      },
    ]);
    expect(a.spoken).toBe(a.points.map((p) => p.say).join(' '));
  });
});

const ACTOR = { id: 'known-alice', name: 'Alice', kind: 'known' };

type Sent = { kind: 'json'; msg: SpokenServerMessage } | { kind: 'audio'; point: number };

/** A voice that stamps each chunk's first byte with the point it says. */
function stampingVoice(points: readonly SpokenPoint[], chunks = 3) {
  const said: string[] = [];
  const voice: SpokenVoice = {
    name: 'stamping',
    async speak(text, onAudio) {
      said.push(text);
      const point = points.findIndex((p) => p.say === text);
      for (let i = 0; i < chunks; i++) {
        await Promise.resolve();
        onAudio(new Uint8Array([point, 0]));
      }
    },
  };
  return { voice, said };
}

/**
 * For every noted point: its note frame is in the log, and no audio frame
 * of that point comes before it. Returns how many notes were checked, so a
 * caller can prove the check was not vacuous.
 */
function assertNotesLead(log: readonly Sent[], points: readonly SpokenPoint[]): number {
  let checked = 0;
  points.forEach((p, i) => {
    if (!p.note) return;
    const noteAt = log.findIndex(
      (e) => e.kind === 'json' && e.msg.type === 'note' && e.msg.point === i,
    );
    const audioAt = log.findIndex((e) => e.kind === 'audio' && e.point === i);
    expect({ point: i, noted: noteAt >= 0 }).toEqual({ point: i, noted: true });
    if (audioAt >= 0)
      expect({ point: i, noteBeforeAudio: noteAt < audioAt }).toEqual({
        point: i,
        noteBeforeAudio: true,
      });
    const sent = log[noteAt];
    expect(sent?.kind === 'json' && sent.msg.type === 'note' ? sent.msg.text : null).toBe(p.note);
    checked++;
  });
  return checked;
}

function sessionWith(engines: Partial<SpokenEngines>, board: SpokenBoard) {
  const log: Sent[] = [];
  const session = new SpokenSession({
    engines: { listener: null, voices: { 1: null, 2: null }, gemini: null, ...engines },
    answerer: new SpokenAnswerer(board, 'w1'),
    timings: new SpokenTimings(undefined, () => {}),
    provenActor: ACTOR,
    readOnly: false,
    parseContext: () => undefined,
    sendJson: (msg) => log.push({ kind: 'json', msg }),
    sendAudio: (pcm) => log.push({ kind: 'audio', point: pcm[0] ?? -1 }),
  });
  return { session, log, send: (m: unknown) => session.onText(JSON.stringify(m)) };
}

function listener() {
  const opened: TranscriptionOpenOpts[] = [];
  const engine: TranscriptionEngine = {
    name: 'fake',
    async open(opts) {
      opened.push(opts);
      return { send: () => {}, close: async () => {} };
    },
  };
  return { engine, opened };
}

/** Both spoken points noted, so the order is checked for each of them. */
const TWO_NOTES =
  'Heard: "move it". Moved "Sign-in" from todo to done. Waiting on you: “approve the mock”.';

function boardSaying(ack: string, route = 'fast-path-action'): SpokenBoard {
  return {
    handle: async () => ({ ok: true, route: route as 'fast-path', ack }),
    goalStatus: () => undefined,
    goals: () => [],
  };
}

describe('a note lands no later than its point’s first audio', () => {
  for (const setup of [1, 2] as const) {
    it(`setup ${setup}: every noted point’s note precedes that point’s audio`, async () => {
      const board = boardSaying(TWO_NOTES);
      const expected = (await new SpokenAnswerer(board, 'w').answer('move it', ACTOR, undefined))
        .points;
      expect(expected.filter((p) => p.note)).toHaveLength(2);
      const v = stampingVoice(expected);
      const l = listener();
      const voices = setup === 1 ? { 1: v.voice, 2: null } : { 1: null, 2: v.voice };
      const h = sessionWith({ listener: l.engine, voices }, board);
      h.send({ type: 'start', setup, mode: 'tap' });
      await waitFor(() => l.opened.length === 1, { describe: 'listener open' });
      l.opened[0]?.onTurn({ turn: 0, text: 'move it', final: true });
      await waitFor(() => h.log.some((e) => e.kind === 'json' && e.msg.type === 'audio-end'), {
        describe: 'audio-end',
      });
      expect(v.said).toEqual(expected.map((p) => p.say));
      expect(assertNotesLead(h.log, expected)).toBe(2);
      // Each point's audio is contiguous and in order: point 1 never plays first.
      const order = h.log.flatMap((e) => (e.kind === 'audio' ? [e.point] : []));
      expect(order).toEqual([0, 0, 0, 1, 1, 1]);
    });
  }

  it('setup 3: every note goes before the tool result that starts the voice', async () => {
    let events: GeminiLiveEvents | null = null;
    const board = boardSaying(TWO_NOTES);
    const log: Sent[] = [];
    const live: GeminiLive = {
      name: 'fake-gemini',
      async open({ events: e }) {
        events = e;
        return {
          sendAudio: () => {},
          activityStart: () => {},
          activityEnd: () => {},
          endStream: () => {},
          sendText: () => {},
          // The voice starts only once the model has the answer.
          answerTool: () => {
            log.push({ kind: 'audio', point: 0 });
            log.push({ kind: 'audio', point: 1 });
          },
          close: () => {},
        };
      },
    };
    const session = new SpokenSession({
      engines: { listener: null, voices: { 1: null, 2: null }, gemini: live },
      answerer: new SpokenAnswerer(board, 'w1'),
      timings: new SpokenTimings(undefined, () => {}),
      provenActor: ACTOR,
      readOnly: false,
      parseContext: () => undefined,
      sendJson: (msg) => log.push({ kind: 'json', msg }),
      sendAudio: () => {},
    });
    session.onText(JSON.stringify({ type: 'start', setup: 3, mode: 'tap' }));
    await waitFor(() => events !== null, { describe: 'gemini open' });
    (events as unknown as GeminiLiveEvents).onToolCall('c1', 'move it');
    await waitFor(() => log.some((e) => e.kind === 'audio'), { describe: 'voice started' });
    const reply = log.find((e) => e.kind === 'json' && e.msg.type === 'reply');
    const points = reply?.kind === 'json' && reply.msg.type === 'reply' ? reply.msg.points : [];
    expect(assertNotesLead(log, points ?? [])).toBe(2);
  });
});

describe('speakPoints', () => {
  const points = withNotes(
    ['Moved "A" from todo to done.', 'Harborlight: 3 open.'],
    'fast-path-action',
  );

  it('a point whose voice sends nothing still gets its note, before the next point', async () => {
    const log: string[] = [];
    await speakPoints({
      voice: {
        name: 'mute-first',
        async speak(text, onAudio) {
          if (text.startsWith('Harborlight')) onAudio(new Uint8Array([1, 0]));
        },
      },
      points,
      signal: new AbortController().signal,
      live: () => true,
      sendJson: (m) => log.push(m.type),
      sendAudio: () => log.push('pcm'),
    });
    expect(log).toEqual(['note', 'audio-start', 'pcm', 'audio-end']);
  });

  it('an abort ends the reply: no later point is said and audio-end closes it', async () => {
    const ctl = new AbortController();
    const said: string[] = [];
    const log: string[] = [];
    await speakPoints({
      voice: {
        name: 'aborting',
        async speak(text, onAudio) {
          said.push(text);
          onAudio(new Uint8Array([0, 0]));
          ctl.abort();
          onAudio(new Uint8Array([0, 0]));
        },
      },
      points,
      signal: ctl.signal,
      live: () => true,
      sendJson: (m) => log.push(m.type),
      sendAudio: () => log.push('pcm'),
    });
    expect(said).toHaveLength(1);
    expect(log).toEqual(['note', 'audio-start', 'pcm', 'audio-end']);
  });
});
