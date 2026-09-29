/**
 * The relay on its own: one session per socket, the upgrade's read-only
 * verdict carried into it, and a closed socket's session dropped.
 */
import { describe, expect, it } from 'bun:test';
import { SpokenReplyRelay, type SpokenWs } from '../src/spoken-reply/relay.ts';
import type { SpokenEngines } from '../src/spoken-reply/session.ts';
import { SpokenTimings } from '../src/spoken-reply/timings.ts';
import type { SpokenVoice } from '../src/spoken-reply/tts.ts';
import type { TranscriptionEngine } from '../src/transcribe.ts';

const NONE: SpokenEngines = { listener: null, voices: { 1: null, 2: null }, gemini: null };
const SOME: SpokenEngines = {
  listener: {} as TranscriptionEngine,
  voices: { 1: {} as SpokenVoice, 2: null },
  gemini: null,
};

function relay(engines: SpokenEngines) {
  return new SpokenReplyRelay({
    engines,
    board: {
      handle: async () => {
        throw new Error('not reached');
      },
      goalStatus: () => undefined,
      goals: () => [],
    },
    timings: new SpokenTimings(undefined, () => {}),
    parseContext: () => undefined,
  });
}

function socket(data: SpokenWs['data']) {
  const sent: Array<Record<string, unknown>> = [];
  const ws: SpokenWs = {
    data,
    send: (p) => {
      if (typeof p === 'string') sent.push(JSON.parse(p) as Record<string, unknown>);
    },
  };
  return { ws, sent };
}

describe('SpokenReplyRelay', () => {
  it('names only the setups whose engines were built', () => {
    expect(relay(NONE).setups()).toEqual([]);
    expect(relay(SOME).setups()).toEqual([1]);
  });

  it('greets each socket with the setups, and a read-only one cannot start', () => {
    const r = relay(SOME);
    const { ws, sent } = socket({ workspaceId: 'w-1', readOnly: true });
    r.onOpen(ws);
    expect(sent[0]).toMatchObject({ type: 'ready', setups: [1] });
    r.onText(ws, JSON.stringify({ type: 'start', setup: 1, mode: 'hold' }));
    expect(sent.at(-1)).toEqual({ type: 'error', message: 'Sign in to use the mic.' });
  });

  it('a setup the server lacks is refused, and a closed socket is forgotten', () => {
    const r = relay(SOME);
    const { ws, sent } = socket({ workspaceId: 'w-1' });
    r.onOpen(ws);
    r.onText(ws, JSON.stringify({ type: 'start', setup: 2, mode: 'hold' }));
    expect(sent.at(-1)).toEqual({
      type: 'error',
      message: 'Setup 2 is not set up on this server.',
    });
    r.onClose(ws);
    const before = sent.length;
    r.onText(ws, JSON.stringify({ type: 'start', setup: 2, mode: 'hold' }));
    expect(sent.length).toBe(before);
  });
});
