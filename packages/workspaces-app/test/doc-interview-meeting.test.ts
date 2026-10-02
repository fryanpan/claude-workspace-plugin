import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackContext, SpokenCaptureOpts } from '../src/board/spoken-reply-audio.ts';
import type { SpokenSocket } from '../src/board/spoken-reply-client.ts';
import { MEETING_PROMPT } from '../src/doc/doc-interview-view.ts';
import { mountDocInterview } from '../src/doc/doc-interview.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * The planning voice's card in a planning meeting: opened by the recording
 * rather than a tap, hearing the meeting (`ears: 'meeting'`) with no
 * microphone of its own and no silence turn, listening again after every
 * reply, logging the delay to the first word, and closed when the
 * recording stops. A discussion's meeting never opens it.
 */

class FakeSocket implements SpokenSocket {
  binaryType = '';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  send(d: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  json(): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }
  reply(m: SpokenServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const playback = {
  currentTime: 1,
  state: 'running',
  resume: async () => {},
  destination: {} as AudioNode,
  createBuffer: (_c: number, length: number, sampleRate: number) =>
    ({ length, sampleRate, copyToChannel: () => {} }) as unknown as AudioBuffer,
  createBufferSource: () =>
    ({
      buffer: null,
      connect: () => {},
      start: () => {},
      stop: () => {},
      onended: null,
    }) as unknown as AudioBufferSourceNode,
} as unknown as PlaybackContext;

let scope: MountScope | null = null;
afterEach(() => {
  scope?.dispose();
  scope = null;
  document.body.replaceChildren();
});

function harness(over: { plan?: boolean; stored?: string } = {}) {
  scope = new MountScope();
  const sockets: FakeSocket[] = [];
  const captures: SpokenCaptureOpts[] = [];
  let record: ((recording: boolean) => void) | null = null;
  const view = mountDocInterview({
    docId: 'd-plan',
    workspaceId: 'w-1',
    author: { id: 'u-1', name: 'Alice' },
    scope,
    setups: [1, 2, 3],
    url: 'ws://board.test/workspaces/w-1/voice/converse',
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    startCapture: async (o) => {
      captures.push(o);
      return { ok: true, capture: { stop: () => {} } };
    },
    captureContext: () => undefined,
    playbackContext: () => playback,
    storage: { getItem: () => over.stored ?? null },
    blocked: () => null,
    silenceMs: 5,
    meeting: {
      onRecording: (fn) => {
        record = fn;
      },
      isPlan: () => over.plan !== false,
    },
  });
  const socket = (): FakeSocket => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket');
    return s;
  };
  const starts = () =>
    socket()
      .json()
      .filter((m) => m.type === 'start');
  return {
    view,
    sockets,
    captures,
    socket,
    starts,
    recording: (on: boolean) => record?.(on),
  };
}

const QUESTION: SpokenServerMessage = {
  type: 'reply',
  spoken: 'Who signs off the berth design?',
  detail: [],
  asking: true,
  route: 'interview',
};

describe('the planning voice in a planning meeting', () => {
  it('opens with the recording and hears the meeting, with no microphone and no silence turn', async () => {
    const h = harness({ stored: '3' });
    h.recording(true);
    h.socket().open();
    expect(h.view.card.hidden).toBe(false);
    expect(h.view.card.querySelector('.doc-interview-question')?.textContent).toBe(MEETING_PROMPT);
    // Setup 3 hears with Gemini, so the meeting is heard on setup 1.
    expect(h.starts()).toEqual([
      {
        type: 'start',
        setup: 1,
        mode: 'tap',
        context: { surface: 'doc', docId: 'd-plan' },
        author: { id: 'u-1', name: 'Alice' },
        ears: 'meeting',
      },
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.captures).toHaveLength(0);
    expect(
      h
        .socket()
        .json()
        .some((m) => m.type === 'end'),
    ).toBe(false);
  });

  it('says the question, logs the delay to its first word, and listens again after every reply', async () => {
    const h = harness();
    h.recording(true);
    h.socket().open();
    h.socket().reply({ type: 'turn-end', text: 'The berth opens in spring.' });
    h.socket().reply(QUESTION);
    expect(h.view.card.querySelector('.doc-interview-question')?.textContent).toBe(QUESTION.spoken);
    h.socket().reply({ type: 'audio-start', sampleRate: 24_000 });
    h.socket().onmessage?.({ data: new Int16Array(480).fill(4000).buffer });
    const timing = h
      .socket()
      .json()
      .find((m) => m.type === 'timing');
    expect(typeof timing?.delayMs).toBe('number');
    h.socket().reply({ type: 'audio-end' });
    await vi.waitFor(() => expect(h.starts()).toHaveLength(2));
    // Claude chose to say nothing, or said something that asks nothing.
    h.socket().reply({ type: 'turn-end', text: 'We start in March.' });
    h.socket().reply({ type: 'reply', spoken: '', detail: [], asking: false, route: 'none' });
    expect(h.starts()).toHaveLength(3);
    expect(h.starts().every((m) => m.ears === 'meeting')).toBe(true);
  });

  it('closes when the recording stops', () => {
    const h = harness();
    h.recording(true);
    h.socket().open();
    h.recording(false);
    expect(h.socket().readyState).toBe(3);
    expect(h.view.card.hidden).toBe(true);
  });

  it('a meeting that is not a plan never opens it', () => {
    const h = harness({ plan: false });
    h.recording(true);
    expect(h.sockets).toHaveLength(0);
    expect(h.view.card.hidden).toBe(true);
  });
});
