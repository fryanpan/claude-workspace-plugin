import type { Anchor, VoiceTarget } from '@claude-workspaces/core';
import { describe, expect, it } from 'vitest';
import { VoiceSession } from '../src/voice/voice-session.ts';
import { type SpeakContext, createQuestionSpeaker } from '../src/voice/voice-speak.ts';
import { FakeSocket, commentFrame, fakeMic, recordingPoster } from './voice-fakes.ts';

/**
 * The one clarifying question, on the page: shown with its choices, said
 * aloud with the microphone held, and answered by a tap that the server turns
 * into an edit of the same note.
 */

const CATALOG: VoiceTarget[] = [
  { i: 1, tag: 'button', text: 'Save' },
  { i: 3, tag: 'button', text: 'Save' },
];
const anchorFor = (target: number | null): Anchor =>
  target === null
    ? { kind: 'subject' }
    : ({ kind: 'element', snippet: { text: `#${target}` } } as unknown as Anchor);

function fakeSpeaker() {
  const log: string[] = [];
  let done: (() => void) | null = null;
  return {
    log,
    end: () => done?.(),
    speaker: {
      wake: () => log.push('wake'),
      begin: (rate: number) => log.push(`begin ${rate}`),
      push: (b: Uint8Array) => log.push(`push ${b.length}`),
      finish: (d: () => void) => {
        log.push('finish');
        done = d;
      },
      stop: () => log.push('stop'),
    },
  };
}

async function asked() {
  const mic = fakeMic();
  const rec = recordingPoster();
  const sp = fakeSpeaker();
  let sock: FakeSocket | null = null;
  const session = new VoiceSession({
    url: 'ws://host/workspaces/w-1/docs/d-1/voice',
    openSocket: (url) => {
      sock = new FakeSocket(url);
      return sock;
    },
    startCapture: mic.start,
    poster: rec.poster,
    catalog: () => CATALOG,
    anchorFor,
    speaker: sp.speaker,
    onChange: () => {},
  });
  await session.start();
  const socket = sock as unknown as FakeSocket;
  socket.open();
  socket.recv({ type: 'ready', segment: 1 });
  socket.recv(commentFrame({ text: 'This Save button is too small.', target: 1 }));
  await new Promise((r) => setTimeout(r, 0));
  socket.recv({
    type: 'ask',
    key: 'v1',
    question: 'Which Save button?',
    choices: ['Save in the header', 'Save in the footer'],
    about: 'anchor',
  });
  return { session, socket, mic, rec, sp };
}

describe('a clarifying question on the page', () => {
  it('is shown with its choices, and a tap answers it; the note is then moved, not made again', async () => {
    const t = await asked();
    expect(t.session.ask).toEqual({
      key: '1.v1',
      question: 'Which Save button?',
      choices: ['Save in the header', 'Save in the footer'],
      about: 'anchor',
    });
    t.session.answer(1);
    expect(t.socket.json().at(-1)).toEqual({ type: 'answer', key: 'v1', choice: 1 });
    expect(t.session.ask).toBeNull();
    t.socket.recv(commentFrame({ text: 'This Save button is too small.', target: 3 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(t.rec.calls.map((c) => c.op)).toEqual(['create', 'reanchor']);
  });

  it('holds the microphone while the question is said, and plays what the server sends', async () => {
    const t = await asked();
    t.socket.recv({ type: 'ask-audio', on: true, sampleRate: 24_000 });
    t.socket.onmessage?.({ data: new Uint8Array(480).buffer });
    const before = t.socket.audio().length;
    t.mic.frame(new Int16Array([1]));
    expect(t.socket.audio(), 'not sent while the question is said').toHaveLength(before);
    t.socket.recv({ type: 'ask-audio', on: false });
    expect(t.sp.log).toEqual(['begin 24000', 'push 480', 'finish']);
    expect(t.session.speaking, 'held until the last word has played').toBe(true);
    t.sp.end();
    t.mic.frame(new Int16Array([2]));
    expect(t.socket.audio()).toHaveLength(before + 1);
  });

  it('comes down when the server takes it back, and stops the voice', async () => {
    const t = await asked();
    t.socket.recv({ type: 'ask-audio', on: true, sampleRate: 24_000 });
    t.socket.recv({ type: 'ask', key: 'v1', question: '', choices: [], about: 'anchor' });
    expect(t.session.ask).toBeNull();
    expect(t.session.speaking).toBe(false);
    expect(t.sp.log.at(-1)).toBe('stop');
  });
});

describe('the question speaker', () => {
  function fakeContext() {
    const starts: number[] = [];
    const ctx = {
      currentTime: 1,
      state: 'running',
      resume: async () => {},
      destination: {} as AudioNode,
      createBuffer: (_c: number, n: number) =>
        ({ length: n, copyToChannel: () => {} }) as unknown as AudioBuffer,
      createBufferSource: () =>
        ({
          connect: () => {},
          start: (at: number) => starts.push(at),
          stop: () => {},
        }) as unknown as AudioBufferSourceNode,
    };
    return { ctx: ctx as SpeakContext, starts };
  }

  it('plays chunks back to back, and calls back once they have played', () => {
    const { ctx, starts } = fakeContext();
    const waits: number[] = [];
    let fire: (() => void) | null = null;
    const sp = createQuestionSpeaker(() => ctx, {
      set: (fn, ms) => {
        waits.push(ms);
        fire = fn;
        return 1;
      },
      clear: () => {},
    });
    sp.begin(24_000);
    sp.push(new Uint8Array(4800)); // 2400 samples: 0.1s
    sp.push(new Uint8Array(4800));
    expect(starts[0]).toBeCloseTo(1.03);
    expect(starts[1], 'the second starts as the first ends').toBeCloseTo(1.13);
    let done = false;
    sp.finish(() => {
      done = true;
    });
    // 0.23s still to play from t=1, and a quarter second's breath after it.
    expect(waits).toHaveLength(1);
    expect(Math.abs((waits[0] ?? 0) - 480)).toBeLessThanOrEqual(1);
    (fire as unknown as () => void)();
    expect(done).toBe(true);
  });

  it('calls back even with no audio context, so the microphone is never held for good', () => {
    let fire: (() => void) | null = null;
    const sp = createQuestionSpeaker(() => null, {
      set: (fn) => {
        fire = fn;
        return 1;
      },
      clear: () => {},
    });
    sp.begin(24_000);
    sp.push(new Uint8Array(480));
    let done = false;
    sp.finish(() => {
      done = true;
    });
    (fire as unknown as () => void)();
    expect(done).toBe(true);
  });
});
