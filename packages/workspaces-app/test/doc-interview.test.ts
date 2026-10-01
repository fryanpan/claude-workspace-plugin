import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackContext, SpokenCaptureOpts } from '../src/board/spoken-reply-audio.ts';
import type { SpokenSocket } from '../src/board/spoken-reply-client.ts';
import { START_PROMPT } from '../src/doc/doc-interview-view.ts';
import { interviewSetup, mountDocInterview } from '../src/doc/doc-interview.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * Interview mode on the review doc, driven with the server, the microphone
 * and the speaker replaced: a socket whose frames the test reads and
 * answers, a capture whose frames the test emits, and a playback context
 * that plays nothing.
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
  frames(): number {
    return this.sent.filter((d) => typeof d !== 'string').length;
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

function harness(over: { stored?: string; setups?: Array<1 | 2 | 3> } = {}) {
  scope = new MountScope();
  const sockets: FakeSocket[] = [];
  const captures: SpokenCaptureOpts[] = [];
  let stops = 0;
  const view = mountDocInterview({
    docId: 'd-plan',
    workspaceId: 'w-1',
    author: { id: 'u-1', name: 'Alice' },
    scope,
    setups: over.setups ?? [1, 2],
    url: 'ws://board.test/workspaces/w-1/voice/converse',
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    startCapture: async (o) => {
      captures.push(o);
      return { ok: true, capture: { stop: () => void stops++ } };
    },
    captureContext: () => undefined,
    playbackContext: () => playback,
    storage: { getItem: () => over.stored ?? null },
    blocked: () => null,
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
  const frame = () => captures[0]?.onFrame(new Int16Array(800), true);
  const text = (sel: string) => view.card.querySelector(sel)?.textContent ?? '';
  return {
    view,
    captures,
    sockets,
    socket,
    starts,
    frame,
    text,
    get stops() {
      return stops;
    },
  };
}

const QUESTION: SpokenServerMessage = {
  type: 'reply',
  spoken: 'I found 4 gaps. First: What goes under Goals?',
  detail: ['1. Goals — empty', '2. Design — placeholder only'],
  asking: true,
  route: 'interview',
};

/** Claude says the reply: its audio starts and ends. */
function speak(h: ReturnType<typeof harness>, m: SpokenServerMessage): void {
  h.socket().reply(m);
  h.socket().reply({ type: 'audio-start', sampleRate: 24_000 });
  h.socket().reply({ type: 'audio-end' });
}

describe('doc interview', () => {
  it('Interview opens the card listening on the doc, in the board’s chosen setup', async () => {
    const h = harness({ stored: '2' });
    h.view.button.click();
    h.socket().open();
    expect(h.view.card.hidden).toBe(false);
    expect(h.view.card.dataset.phase).toBe('listening');
    expect(h.text('.doc-interview-question')).toBe(START_PROMPT);
    expect(h.starts()).toEqual([
      {
        type: 'start',
        setup: 2,
        mode: 'tap',
        context: { surface: 'doc', docId: 'd-plan' },
        author: { id: 'u-1', name: 'Alice' },
      },
    ]);
    await vi.waitFor(() => expect(h.captures).toHaveLength(1));
    h.frame();
    expect(h.socket().frames()).toBe(1);
  });

  it('after a question is said it listens again by itself, and sends nothing while Claude talks', async () => {
    const h = harness();
    h.view.button.click();
    h.socket().open();
    await vi.waitFor(() => expect(h.captures).toHaveLength(1));
    h.socket().reply({ type: 'turn-end', text: 'interview me' });
    expect(h.view.card.dataset.phase).toBe('thinking');
    h.socket().reply(QUESTION);
    expect(h.text('.doc-interview-question')).toBe(QUESTION.spoken);
    expect(h.view.card.querySelectorAll('.doc-interview-detail li')).toHaveLength(2);
    h.socket().reply({ type: 'audio-start', sampleRate: 24_000 });
    h.frame();
    expect(h.socket().frames()).toBe(0);
    h.socket().reply({ type: 'audio-end' });
    await vi.waitFor(() => expect(h.starts()).toHaveLength(2));
    expect(h.view.card.dataset.phase).toBe('listening');
    h.frame();
    expect(h.socket().frames()).toBe(1);
    for (const b of h.view.commands) expect(b.disabled).toBe(false);
  });

  it.each([
    ['Skip', 'skip'],
    ['Later', 'come back to that'],
    ['Finish', 'that’s enough'],
  ])('%s says "%s" for you', async (label, said) => {
    const h = harness();
    h.view.button.click();
    h.socket().open();
    speak(h, QUESTION);
    await vi.waitFor(() => expect(h.starts()).toHaveLength(2));
    const b = h.view.commands.find((c) => c.textContent === label);
    b?.click();
    expect(h.socket().json().at(-1)).toEqual({ type: 'say', text: said });
    expect(h.view.card.dataset.phase).toBe('thinking');
  });

  it('the interview’s end stops the listening, and the commands go quiet', async () => {
    const h = harness();
    h.view.button.click();
    h.socket().open();
    speak(h, QUESTION);
    await vi.waitFor(() => expect(h.starts()).toHaveLength(2));
    speak(h, {
      type: 'reply',
      spoken: 'Stopping here. 1 of 4 gaps filled.',
      detail: [],
      asking: false,
      route: 'interview',
    });
    await vi.waitFor(() => expect(h.view.card.dataset.phase).toBe('done'));
    expect(h.starts()).toHaveLength(2);
    for (const b of h.view.commands) expect(b.disabled).toBe(true);
    expect(h.view.primary.textContent).toBe('Talk');
  });

  it('Done ends an answer by hand; closing mid-interview ends it on the server', async () => {
    const h = harness();
    h.view.button.click();
    h.socket().open();
    speak(h, QUESTION);
    await vi.waitFor(() => expect(h.starts()).toHaveLength(2));
    expect(h.view.primary.textContent).toBe('Done');
    h.view.primary.click();
    expect(h.socket().json().at(-1)).toEqual({ type: 'end' });
    h.view.close.click();
    expect(h.socket().json().at(-1)).toEqual({ type: 'say', text: 'that’s enough' });
    expect(h.view.card.hidden).toBe(true);
    expect(h.stops).toBe(1);
  });
});

describe('interviewSetup', () => {
  it('takes the board’s choice when this server runs it, else the first it runs', () => {
    expect(interviewSetup([1, 2, 3], '3')).toBe(3);
    expect(interviewSetup([1, 3], '2')).toBe(1);
    expect(interviewSetup([3], null)).toBe(3);
    expect(interviewSetup([], '1')).toBeNull();
  });
});
