/**
 * Gemini Live's adapter against a fake socket, and the per-setup delay log.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASK_BOARD,
  type GeminiLiveEvents,
  type GeminiSocketArgs,
  createGeminiLive,
  geminiSetup,
} from '../src/spoken-reply/gemini-live.ts';
import { SpokenTimings, summarize } from '../src/spoken-reply/timings.ts';

function recorder(): GeminiLiveEvents & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    onInputText: (t) => log.push(`in:${t}`),
    onOutputText: (t) => log.push(`out:${t}`),
    onAudio: (p) => log.push(`audio:${p.length}`),
    onToolCall: (id, r) => log.push(`tool:${id}:${r}`),
    onTurnComplete: () => log.push('complete'),
    onInterrupted: () => log.push('interrupted'),
    onError: (m) => log.push(`error:${m}`),
    onClose: () => log.push('close'),
  };
}

describe('Gemini Live adapter', () => {
  it('sends the setup, resolves on setupComplete, and reads what comes back', async () => {
    const sent: string[] = [];
    let args: GeminiSocketArgs | null = null;
    const live = createGeminiLive({
      apiKey: 'placeholder',
      socketFactory: (a) => {
        args = a;
        queueMicrotask(() => a.onOpen());
        return { send: (d) => sent.push(d), close: () => {} };
      },
    });
    const events = recorder();
    const opening = live.open({ manual: true, events });
    await Promise.resolve();
    await Promise.resolve();
    const a = args as GeminiSocketArgs | null;
    if (!a) throw new Error('no socket');
    expect(JSON.parse(sent[0] ?? '{}')).toEqual(geminiSetup(true));
    a.onMessage(JSON.stringify({ setupComplete: {} }));
    const session = await opening;
    session.activityStart();
    session.sendAudio(new Uint8Array([1, 2]));
    session.answerTool('c1', { spoken: 'Hi.' });
    expect(sent.slice(1).map((s) => JSON.parse(s))).toEqual([
      { realtimeInput: { activityStart: {} } },
      { realtimeInput: { audio: { data: 'AQI=', mimeType: 'audio/pcm;rate=16000' } } },
      {
        toolResponse: {
          functionResponses: [{ id: 'c1', name: ASK_BOARD, response: { spoken: 'Hi.' } }],
        },
      },
    ]);
    a.onMessage(JSON.stringify({ serverContent: { inputTranscription: { text: 'status' } } }));
    a.onMessage(
      JSON.stringify({
        toolCall: { functionCalls: [{ id: 'c1', name: ASK_BOARD, args: { request: 'status' } }] },
      }),
    );
    a.onMessage(
      JSON.stringify({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { data: 'AQIDBA==', mimeType: 'audio/pcm' } }] },
          outputTranscription: { text: 'Hi.' },
        },
      }),
    );
    a.onMessage(JSON.stringify({ serverContent: { turnComplete: true } }));
    expect(events.log).toEqual(['in:status', 'tool:c1:status', 'audio:4', 'out:Hi.', 'complete']);
  });

  it('the setup asks for a blocking tool, and VAD is off only for hold-to-talk', () => {
    const hold = geminiSetup(true).setup as Record<string, unknown>;
    const tap = geminiSetup(false).setup as Record<string, unknown>;
    const tools = hold.tools as Array<{ functionDeclarations: Array<{ behavior: string }> }>;
    expect(tools[0]?.functionDeclarations[0]?.behavior).toBe('BLOCKING');
    expect(hold.realtimeInputConfig).toEqual({ automaticActivityDetection: { disabled: true } });
    expect(tap.realtimeInputConfig).toEqual({
      automaticActivityDetection: {
        endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
        silenceDurationMs: 3500,
      },
    });
  });

  it('a close before setup rejects with Google’s reason', async () => {
    const live = createGeminiLive({
      apiKey: 'placeholder',
      socketFactory: (a) => {
        queueMicrotask(() => a.onClose('API not enabled'));
        return { send: () => {}, close: () => {} };
      },
    });
    const err = await live.open({ manual: false, events: recorder() }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe('gemini: closed before setup (API not enabled)');
  });
});

describe('SpokenTimings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spoken-timings-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('median, p90 and last per setup', () => {
    const at = 0;
    const s = summarize([
      { setup: 1, delayMs: 100, at },
      { setup: 1, delayMs: 300, at },
      { setup: 1, delayMs: 200, at },
      { setup: 3, delayMs: 900, at },
    ]);
    expect(s).toEqual({
      '1': { n: 3, medianMs: 200, p90Ms: 300, lastMs: 200 },
      '3': { n: 1, medianMs: 900, p90Ms: 900, lastMs: 900 },
    });
  });

  it('appends to the file and reads it back after a restart', () => {
    const file = join(dir, 'spoken-reply-timings.jsonl');
    const first = new SpokenTimings(file, () => {});
    first.record({ setup: 2, delayMs: 640, at: 1 });
    first.record({ setup: 2, delayMs: 720, at: 2 });
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
    const second = new SpokenTimings(file, () => {});
    expect(second.summary()).toEqual({ '2': { n: 2, medianMs: 640, p90Ms: 720, lastMs: 720 } });
  });
});
