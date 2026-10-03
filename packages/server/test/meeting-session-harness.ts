/**
 * A spoken-reply session hearing a meeting through `MeetingEars`, on a fake
 * clock, for the meeting-voice tests: the board and the plan reader are
 * scripts, the voice records what it was given, and the notes are the lines
 * the meeting's `note` was handed. Fixture names are the house ones.
 */
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { SpokenAnswerer, type SpokenBoard } from '../src/spoken-reply/answer.ts';
import type { PlanComplete } from '../src/spoken-reply/interview-reader.ts';
import { MeetingEars } from '../src/spoken-reply/meeting-ears.ts';
import type { GateTimers } from '../src/spoken-reply/pause-gate.ts';
import { SpokenSession } from '../src/spoken-reply/session.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../src/transcribe.ts';
import { parseVoiceContext } from '../src/voice.ts';
import { DOC_ID, type Fixture, ROUTED, WS, planFixture } from './interview-fixture.ts';
import { waitFor } from './wait-for.ts';

export function fakeClock() {
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
    now = Math.max(now, t);
  };
  return { timers, advanceTo, now: () => now };
}

const UNUSED: TranscriptionEngine = {
  name: 'unused',
  open: () => Promise.reject(new Error('not this one')),
};

export interface HeardMeeting {
  fx: Fixture;
  session: SpokenSession;
  json: SpokenServerMessage[];
  said: string[];
  notes: string[];
  clock: ReturnType<typeof fakeClock>;
  /** The page's `start`, as it sends one after every reply. */
  listen(): void;
  /** A frame of the meeting, on the page's own microphone. */
  hear(turn: number, text: string, final: boolean): void;
  /** Wait until the listener is open, hearing one word that is no request. */
  ready(): Promise<void>;
  replies(): Array<Extract<SpokenServerMessage, { type: 'reply' }>>;
  stop(): void;
}

export async function heardMeeting(
  o: {
    plan?: boolean;
    owner?: boolean;
    board?: SpokenBoard;
    markdown?: string;
    complete?: PlanComplete;
    warmup?: boolean;
  } = {},
): Promise<HeardMeeting> {
  const ears = new MeetingEars();
  const fx = await planFixture({
    ...(o.markdown !== undefined ? { markdown: o.markdown } : {}),
    ...(o.complete ? { complete: o.complete } : {}),
    ...(o.warmup ? { warmup: true } : {}),
    ears,
  });
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
    answerer: new SpokenAnswerer(o.board ?? ROUTED, WS, fx.interview),
    timings: new SpokenTimings(undefined, () => {}),
    provenActor: { id: 'known-owner', name: 'Owner' },
    readOnly: false,
    parseContext: parseVoiceContext,
    sendJson: (m) => json.push(m),
    sendAudio: () => {},
    timers: clock.timers,
    ownerOnPage: o.owner ?? true,
    meetingEars: (docId) => ({
      engine: ears.engine(docId),
      plan: o.plan ?? false,
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
  const hear = (turn: number, text: string, final: boolean) =>
    ears.heard(DOC_ID, { turn, text, final, stream: 'mic' });
  const ready = async () => {
    const before = json.filter((m) => m.type === 'heard').length;
    await waitFor(
      () => {
        ears.heard(DOC_ID, { turn: -1, text: 'Mm', final: false, stream: 'mic' });
        return json.filter((m) => m.type === 'heard').length > before;
      },
      { describe: 'hearing the meeting' },
    );
  };
  const replies = () =>
    json.filter((m): m is Extract<SpokenServerMessage, { type: 'reply' }> => m.type === 'reply');
  const stop = () => {
    session.close();
    fx.stop();
  };
  return { fx, session, json, said, notes, clock, listen, hear, ready, replies, stop };
}

/** A board whose every answer is `ack`, on `route`. */
export function boardSaying(ack: string, route = 'fast-path', queueId?: string): SpokenBoard {
  return {
    async handle() {
      return { ok: true, route: route as 'fast-path', ack, ...(queueId ? { queueId } : {}) };
    },
    goalStatus: () => undefined,
    goals: () => [],
  };
}

export const wordsIn = (s: string): number => s.split(/\s+/).filter(Boolean).length;
