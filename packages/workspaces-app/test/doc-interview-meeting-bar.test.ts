import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import { afterEach, describe, expect, it } from 'vitest';
import type { SpokenSocket } from '../src/board/spoken-reply-client.ts';
import { PAUSE_KEY } from '../src/doc/doc-interview-bar.ts';
import { mountDocInterview } from '../src/doc/doc-interview.ts';
import { MountScope } from '../src/mount-scope.ts';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The planning voice's part of the meeting bar and its card in a meeting: no
 * Done, Skip, Later or Finish; the pause setting, kept per device and sent
 * with every `start` and on every change; and the steady "Claude · …" line
 * while the lead works on a "Claude, …", gone when the answer is in. Read as
 * computed style under the real stylesheets, at 1180 and 430 wide.
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

let scope: MountScope | null = null;
let uninstall: (() => void) | null = null;
afterEach(() => {
  scope?.dispose();
  scope = null;
  uninstall?.();
  uninstall = null;
  document.body.replaceChildren();
});

function harness(stored: Record<string, string> = {}) {
  uninstall = installSheets('styles.css', 'doc.css');
  scope = new MountScope();
  const strip = document.createElement('div');
  strip.className = 'meeting-strip';
  strip.dataset.state = 'recording';
  document.body.append(strip);
  const sockets: FakeSocket[] = [];
  let record: ((recording: boolean) => void) | null = null;
  const view = mountDocInterview({
    docId: 'd-plan',
    workspaceId: 'w-1',
    author: { id: 'u-1', name: 'Alice' },
    scope,
    setups: [1, 2],
    url: 'ws://board.test/workspaces/w-1/voice/converse',
    openSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    startCapture: async () => ({ ok: true, capture: { stop: () => {} } }),
    captureContext: () => undefined,
    playbackContext: () => null,
    storage: { getItem: () => null },
    pauseStorage: {
      getItem: (k) => stored[k] ?? null,
      setItem: (k, v) => void (stored[k] = v),
    },
    blocked: () => null,
    meeting: {
      onRecording: (fn) => {
        record = fn;
      },
      isPlan: () => true,
      bar: strip,
    },
  });
  const socket = (): FakeSocket => {
    const s = sockets.at(-1);
    if (!s) throw new Error('no socket');
    return s;
  };
  const q = <T extends Element>(sel: string): T => {
    const el = document.querySelector<T>(sel);
    if (!el) throw new Error(`no ${sel}`);
    return el;
  };
  return { view, strip, socket, q, stored, recording: (on: boolean) => record?.(on) };
}

describe('a meeting’s card', () => {
  it('has no Done, Skip, Later or Finish, only its ×; a tapped card keeps them', () => {
    setViewport(IPAD);
    const h = harness();
    h.recording(true);
    h.view.button.click();
    expect(styleOf(h.view.card).display).not.toBe('none');
    expect(styleOf(h.q('.doc-interview-foot')).display).toBe('none');
    expect(styleOf(h.view.close).display).not.toBe('none');

    h.recording(false);
    h.view.button.click();
    expect(styleOf(h.view.card).display).not.toBe('none');
    expect(styleOf(h.q('.doc-interview-foot')).display).toBe('flex');
    expect(h.view.commands.map((b) => b.textContent)).toEqual(['Skip', 'Later', 'Finish']);
  });
});

describe('the pause setting in the meeting bar', () => {
  it('shows while the meeting is heard, sends its waits with every start and on a change, and is kept', () => {
    setViewport(IPAD);
    const h = harness({ [PAUSE_KEY]: JSON.stringify({ finishedMs: 2000, unfinishedMs: 4000 }) });
    const setting = h.q<HTMLButtonElement>('.meeting-voice-pause');
    expect(styleOf(h.q('.meeting-voice')).display).toBe('none');
    h.recording(true);
    h.socket().open();
    expect(styleOf(h.q('.meeting-voice')).display).toBe('flex');
    expect(setting.textContent).toBe('Pause 2s · 4s');
    expect(
      h
        .socket()
        .json()
        .find((m) => m.type === 'start')?.pause,
    ).toEqual({
      finishedMs: 2000,
      unfinishedMs: 4000,
    });

    const pop = h.q('.meeting-voice-pop');
    expect(styleOf(pop).display).toBe('none');
    setting.click();
    expect(styleOf(pop).display).toBe('grid');
    const [finished, unfinished] = Array.from(pop.querySelectorAll('select'));
    if (!finished || !unfinished) throw new Error('no selects');
    unfinished.value = '6000';
    unfinished.dispatchEvent(new Event('change'));
    expect(h.socket().json().at(-1)).toEqual({
      type: 'pause',
      pause: { finishedMs: 2000, unfinishedMs: 6000 },
    });
    expect(setting.textContent).toBe('Pause 2s · 6s');
    expect(JSON.parse(h.stored[PAUSE_KEY] ?? '{}')).toEqual({
      finishedMs: 2000,
      unfinishedMs: 6000,
    });

    // The next start carries it too.
    h.socket().reply({ type: 'reply', spoken: '', detail: [], asking: false, route: 'none' });
    expect(
      h
        .socket()
        .json()
        .filter((m) => m.type === 'start')
        .at(-1)?.pause,
    ).toEqual({
      finishedMs: 2000,
      unfinishedMs: 6000,
    });
    h.recording(false);
    expect(styleOf(h.q('.meeting-voice')).display).toBe('none');
  });

  it('a stored value out of range is ignored for the defaults', () => {
    setViewport(IPAD);
    const h = harness({ [PAUSE_KEY]: JSON.stringify({ finishedMs: 50, unfinishedMs: 3000 }) });
    h.recording(true);
    expect(h.q('.meeting-voice-pause').textContent).toBe('Pause 1.5s · 3s');
  });
});

describe('what Claude is working on', () => {
  it('one steady line while the lead works, gone when the answer is in, keeping its width', () => {
    setViewport(IPAD);
    const h = harness();
    h.recording(true);
    h.socket().open();
    const line = h.q('.meeting-voice-doing');
    const setting = h.q('.meeting-voice-pause');
    expect(styleOf(line).visibility).toBe('hidden');
    const widthBefore = styleOf(line).width;
    h.socket().reply({ type: 'doing', label: 'find the Riverbend ferry' });
    expect(line.textContent).toBe('Claude · find the Riverbend ferry…');
    expect(styleOf(line).visibility).toBe('visible');
    expect(styleOf(line).width).toBe(widthBefore);
    expect(styleOf(setting).display).not.toBe('none');
    h.socket().reply({ type: 'doing', label: null });
    expect(styleOf(line).visibility).toBe('hidden');
    expect(line.textContent).toBe('');
  });

  it('on a phone the bar shows only while Claude works, and the setting stays off', () => {
    setViewport(PHONE);
    const h = harness();
    h.recording(true);
    h.socket().open();
    expect(styleOf(h.strip).display).toBe('none');
    h.socket().reply({ type: 'doing', label: 'draft the Saltmarsh notice' });
    expect(styleOf(h.strip).display).toBe('flex');
    expect(styleOf(h.q('.meeting-voice-pause')).display).toBe('none');
    h.socket().reply({ type: 'doing', label: null });
    expect(styleOf(h.strip).display).toBe('none');
  });
});
