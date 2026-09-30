import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireBoardVoice } from '../src/board/board-voice.ts';
import type { PlaybackContext, SpokenCaptureOpts } from '../src/board/spoken-reply-audio.ts';
import { frameRms, pcm16ToFloat } from '../src/board/spoken-reply-audio.ts';
import {
  SETUP_KEY,
  type SpokenReplyOpts,
  type SpokenSocket,
  TAP_MS,
  createSpokenReply,
} from '../src/board/spoken-reply-client.ts';
import { boardState, mountShell, task } from './support/board-region-harness.ts';

/**
 * The board mic's spoken reply, driven end to end on the page with the
 * server, the microphone and the speaker replaced: a socket whose frames the
 * test reads and answers, a capture that emits the frames the test says, and
 * an audio context whose clock the test holds.
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
  audio(samples: number[]): void {
    const b = new Uint8Array(samples.length * 2);
    const v = new DataView(b.buffer);
    samples.forEach((s, i) => v.setInt16(i * 2, s, true));
    this.onmessage?.({ data: b.buffer });
  }
}

function fakePlayback() {
  const started: number[] = [];
  let stopped = 0;
  const ctx = {
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
        start: (t: number) => started.push(t),
        stop: () => {
          stopped++;
        },
        onended: null,
      }) as unknown as AudioBufferSourceNode,
  };
  return {
    ctx: ctx as unknown as PlaybackContext,
    started,
    get stopped() {
      return stopped;
    },
  };
}

function harness(over: Partial<SpokenReplyOpts> = {}) {
  const el = mountShell();
  const sockets: FakeSocket[] = [];
  const captures: SpokenCaptureOpts[] = [];
  let captureStops = 0;
  let clock = 1000;
  const play = fakePlayback();
  const store = new Map<string, string>();
  const navigated: string[] = [];
  const reply = createSpokenReply({
    document,
    button: el('board-mic'),
    url: 'ws://board.test/workspaces/w-1/voice/converse',
    setups: [1, 2],
    timings: {},
    author: { id: 'u-1', name: 'Alice', kind: 'known' },
    getContext: () => ({ taskId: 't-1' }),
    onNavigate: (u) => navigated.push(u),
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    startCapture: async (o) => {
      captures.push(o);
      return {
        ok: true,
        capture: {
          stop: () => {
            captureStops++;
          },
        },
      };
    },
    captureContext: () => undefined,
    playbackContext: () => play.ctx,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    now: () => clock,
    ...over,
  });
  const mic = el('board-mic');
  return {
    reply,
    panel: reply.panel,
    mic,
    sockets,
    get socket() {
      const s = sockets.at(-1);
      if (!s) throw new Error('no socket');
      return s;
    },
    captures,
    get captureStops() {
      return captureStops;
    },
    play,
    store,
    navigated,
    tick: (ms: number) => {
      clock += ms;
    },
    /** One 50 ms frame, loud or quiet. */
    frame: (loud: boolean) =>
      captures.at(-1)?.onFrame(new Int16Array(800).fill(loud ? 3000 : 0), loud),
    text: () => reply.panel.root.textContent ?? '',
    label: () => reply.panel.root.querySelector('.vr-state')?.textContent,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('spoken reply', () => {
  it('a held question: start after TAP_MS with the frames said before it, end on release', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.panel.isOpen()).toBe(true);
    expect(h.label()).toBe('Listening');
    h.frame(true);
    h.frame(true);
    await vi.advanceTimersByTimeAsync(TAP_MS);
    h.socket.open();
    const start = h.socket.json()[0];
    expect(start).toMatchObject({ type: 'start', setup: 1, mode: 'hold' });
    expect(start?.context).toEqual({ taskId: 't-1' });
    expect(h.socket.frames()).toBe(2);
    h.frame(false);
    expect(h.socket.frames()).toBe(3);
    h.tick(400);
    h.mic.dispatchEvent(new Event('pointerup'));
    expect(h.socket.json().at(-1)).toEqual({ type: 'end' });
    expect(h.captureStops).toBe(1);
    expect(h.label()).toBe('Heard you');
  });

  it('writes the reply, speaks it, and logs the delay from release to the first audible sample', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(TAP_MS);
    h.socket.open();
    h.frame(true);
    h.mic.dispatchEvent(new Event('pointerup')); // released at 1000
    h.tick(300);
    h.socket.reply({ type: 'turn-end', text: 'give me a status update' });
    h.tick(20);
    h.socket.reply({
      type: 'reply',
      spoken: 'Harborlight: 3 open. Waiting on you: 1.',
      detail: ['In progress: “Riverbend import”.'],
      asking: false,
      route: 'fast-path',
    });
    expect(h.label()).toBe('Writing');
    expect(h.text()).toContain('Harborlight: 3 open. Waiting on you: 1.');
    expect(h.panel.root.querySelectorAll('.vr-detail li')).toHaveLength(1);
    h.tick(200);
    h.socket.reply({ type: 'audio-start', sampleRate: 24000 });
    expect(h.label()).toBe('Speaking');
    // Silence first, then the word: the delay runs to the audible sample,
    // scheduled 30 ms ahead of the context clock.
    h.socket.audio([0, 0, 0, 0, 4000]);
    expect(h.play.started).toEqual([1.03]);
    const timing = h.socket.json().find((m) => m.type === 'timing');
    expect(timing?.endpointMs).toBe(300);
    expect(timing?.replyMs).toBe(20);
    expect(Math.round(Number(timing?.delayMs))).toBe(550);
    expect(h.panel.root.querySelector('.vr-delay b')?.textContent).toBe('550');
    h.socket.reply({ type: 'audio-end' });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.label()).toBe('Done');
  });

  it('a tap: the listener ends the question, and a second tap ends it by hand', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(50);
    h.mic.dispatchEvent(new Event('pointerup'));
    h.socket.open();
    expect(h.socket.json()[0]).toMatchObject({ type: 'start', mode: 'tap' });
    expect(h.label()).toBe('Listening');
    h.mic.dispatchEvent(new Event('pointerdown'));
    expect(h.socket.json().at(-1)).toEqual({ type: 'end' });
    expect(h.label()).toBe('Heard you');
  });

  it('speaking while Claude talks stops it', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(TAP_MS);
    h.socket.open();
    h.mic.dispatchEvent(new Event('pointerup'));
    h.socket.reply({ type: 'reply', spoken: 'One. Two.', detail: [], asking: false, route: 'x' });
    h.socket.reply({ type: 'audio-start', sampleRate: 24000 });
    h.socket.audio([4000]);
    h.mic.dispatchEvent(new Event('pointerdown'));
    expect(h.socket.json().map((m) => m.type)).toContain('stop');
    expect(h.play.stopped).toBe(1);
    expect(h.label()).toBe('Listening');
    expect(h.text()).toContain('Stopped when you started talking.');
  });

  it('asks one question, offers its choices, and a tapped choice is sent as said', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(TAP_MS);
    h.socket.open();
    h.mic.dispatchEvent(new Event('pointerup'));
    h.socket.reply({
      type: 'reply',
      spoken: 'Which goal: Harborlight or Riverbend?',
      detail: ['Say first or second, or a goal’s name.'],
      asking: true,
      choices: ['Harborlight', 'Riverbend'],
      route: 'fast-path',
    });
    h.socket.reply({ type: 'audio-start', sampleRate: 24000 });
    expect(h.label()).toBe('Asking you');
    h.socket.reply({ type: 'audio-end' });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.label()).toBe('Waiting for your answer');
    const choice = [...h.panel.root.querySelectorAll<HTMLButtonElement>('.vr-choices button')];
    expect(choice.map((b) => b.textContent)).toEqual(['Harborlight', 'Riverbend']);
    choice[1]?.click();
    expect(h.socket.json().at(-1)).toEqual({ type: 'say', text: 'Riverbend' });
    expect(h.label()).toBe('Heard you');
  });

  it('Stop while asking waits for the answer; Stop while speaking stops', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(TAP_MS);
    h.socket.open();
    h.mic.dispatchEvent(new Event('pointerup'));
    h.socket.reply({ type: 'reply', spoken: 'One. Two.', detail: [], asking: false, route: 'x' });
    h.socket.reply({ type: 'audio-start', sampleRate: 24000 });
    const stop = h.panel.root.querySelector<HTMLButtonElement>('.vr-stop');
    expect(stop?.disabled).toBe(false);
    stop?.click();
    expect(h.label()).toBe('Stopped');
    expect(stop?.disabled).toBe(true);
  });

  it('the setup switch: remembered per device, and a setup the server lacks is disabled', () => {
    const h = harness();
    const buttons = [...h.panel.root.querySelectorAll<HTMLButtonElement>('.vr-setups button')];
    expect(buttons.map((b) => b.disabled)).toEqual([false, false, true]);
    buttons[1]?.click();
    expect(h.store.get(SETUP_KEY)).toBe('2');
    expect(h.panel.root.querySelector('.vr-setup-name')?.textContent).toBe('Soniox + ElevenLabs');
    buttons[2]?.click();
    expect(h.reply.setup()).toBe(2);
  });

  it('a held setup 2: choosing it says why in one line, and pressing speaks nothing', async () => {
    const line = 'Setup 2 waits on turning off ElevenLabs training.';
    const h = harness({ setups: [1], held: { '2': line } });
    const buttons = [...h.panel.root.querySelectorAll<HTMLButtonElement>('.vr-setups button')];
    expect(buttons.map((b) => b.disabled)).toEqual([false, false, true]);
    expect(buttons[1]?.title).toBe(line);
    buttons[1]?.click();
    expect(h.reply.setup()).toBe(2);
    expect(h.panel.root.querySelector('.vr-body')?.textContent).toBe(line);
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(TAP_MS * 2);
    expect(h.sockets).toEqual([]);
    expect(h.captures).toEqual([]);
    expect(h.panel.root.querySelector('.vr-body')?.textContent).toBe(line);
    // Setup 1 is untouched: it opens the socket and listens.
    buttons[0]?.click();
    h.mic.dispatchEvent(new Event('pointerup'));
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(TAP_MS);
    expect(h.sockets.length).toBe(1);
    expect(h.label()).toBe('Listening');
  });

  it('opens above the feedback widget’s corner buttons rather than under them', () => {
    const rect = (left: number, top: number, w: number, h: number) =>
      ({ left, top, right: left + w, bottom: top + h, width: w, height: h }) as DOMRect;
    const host = document.createElement('claude-feedback-widget');
    const shadow = host.attachShadow({ mode: 'open' });
    const at = [rect(365, 810, 48, 48), rect(365, 760, 40, 40), rect(700, 100, 40, 40)];
    for (const r of at) {
      const b = document.createElement('button');
      b.getBoundingClientRect = () => r;
      shadow.append(b);
    }
    Object.defineProperty(document.documentElement, 'clientWidth', {
      value: 430,
      configurable: true,
    });
    vi.stubGlobal('innerHeight', 932);
    const h = harness();
    document.body.append(host);
    h.mic.getBoundingClientRect = () => rect(10, 883, 44, 44);
    h.panel.open();
    // Both stacked buttons overlap the panel's column; the one off to the side does not count.
    expect(h.panel.root.style.bottom).toBe(`${932 - 760 + 8}px`);
    expect(h.panel.root.style.width).toBe('398px');
    Reflect.deleteProperty(document.documentElement, 'clientWidth');
  });

  it('a server error is shown and ends the turn', async () => {
    const h = harness();
    h.mic.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(TAP_MS);
    h.socket.open();
    h.socket.reply({ type: 'error', message: 'Setup 1 is not set up on this server.' });
    expect(h.label()).toBe('Done');
    expect(h.text()).toContain('Setup 1 is not set up on this server.');
    expect(h.captureStops).toBe(1);
  });
});

describe('spoken-reply audio helpers', () => {
  it('reads loudness and little-endian PCM', () => {
    expect(frameRms(new Int16Array(4))).toBe(0);
    expect(frameRms(new Int16Array([16384, -16384]))).toBeCloseTo(0.5);
    const f = pcm16ToFloat(new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0x01]));
    expect([...f]).toEqual([0.5, -0.5]);
  });
});

describe('wireBoardVoice with the spoken reply', () => {
  function mount(setups: number[], held: Record<string, string> = {}) {
    const el = mountShell();
    const opened: FakeSocket[] = [];
    const fetched: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      fetched.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ setups, held, timings: {} }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    wireBoardVoice({
      state: boardState({ tasks: new Map([['t-1', task('t-1')]]) }),
      author: { id: 'u-1', name: 'Alice', kind: 'known' },
      workspaceId: 'w-1',
      document,
      location: { origin: 'http://board.test', pathname: '/workspaces/w-1', assign: () => {} },
      el,
      renderDetail: () => {},
      spoken: {
        host: 'board.test',
        protocol: 'http:',
        openSocket: (u) => {
          const s = new FakeSocket();
          (s as unknown as { url: string }).url = u;
          opened.push(s);
          return s;
        },
        startCapture: async () => ({ ok: true, capture: { stop: () => {} } }),
        playbackContext: () => fakePlayback().ctx,
      },
    });
    return { el, opened, fetched };
  }

  it('swaps in the spoken mic when the server names a setup', async () => {
    const m = mount([1]);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.fetched).toEqual(['/workspaces/w-1/voice/timings']);
    m.el('board-mic').dispatchEvent(new Event('pointerdown'));
    expect(document.getElementById('vr-panel')?.classList.contains('hidden')).toBe(false);
    expect((m.opened[0] as unknown as { url: string }).url).toBe(
      'ws://board.test/workspaces/w-1/voice/converse',
    );
  });

  it('mounts the spoken mic for a held setup alone, so the panel can say why', async () => {
    const line = 'Setup 2 waits on turning off ElevenLabs training.';
    const m = mount([], { '2': line });
    await vi.advanceTimersByTimeAsync(0);
    m.el('board-mic').dispatchEvent(new Event('pointerdown'));
    expect(document.querySelector('#vr-panel .vr-body')?.textContent).toBe(line);
    expect(m.opened).toEqual([]);
  });

  it('keeps the plain mic when the server can speak no setup', async () => {
    const m = mount([]);
    await vi.advanceTimersByTimeAsync(0);
    m.el('board-mic').dispatchEvent(new Event('pointerdown'));
    expect(document.getElementById('vr-panel')).toBeNull();
    expect(m.opened).toEqual([]);
  });
});
