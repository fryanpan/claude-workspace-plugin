/**
 * The two voices, driven against fakes of their vendors: a fake socket for
 * Soniox TTS and a fake fetch for ElevenLabs. No network, no key.
 */
import { describe, expect, it } from 'bun:test';
import {
  ELEVENLABS_MODEL,
  createElevenLabsVoice,
  createSonioxVoice,
  elevenLabsUrl,
} from '../src/spoken-reply/tts.ts';
import type { EngineSocketArgs } from '../src/transcribe-assemblyai.ts';
import { waitFor } from './wait-for.ts';

const KEY = 'placeholder-key';

function fakeSocket() {
  const sent: string[] = [];
  let args: EngineSocketArgs | null = null;
  let closed = false;
  return {
    sent,
    get closed() {
      return closed;
    },
    factory: (a: EngineSocketArgs) => {
      args = a;
      queueMicrotask(() => a.onOpen());
      return {
        send: (d: string | Uint8Array) => sent.push(String(d)),
        close: () => {
          closed = true;
        },
      };
    },
    push: (msg: unknown) => args?.onMessage(JSON.stringify(msg)),
  };
}

const until = (pred: () => boolean) => waitFor(pred, { interval: 2, describe: 'frames sent' });

describe('Soniox voice', () => {
  it('sends the config then the text, and streams the audio until audio_end', async () => {
    const s = fakeSocket();
    const voice = createSonioxVoice({ apiKey: KEY, socketFactory: s.factory });
    const chunks: number[][] = [];
    const said = voice.speak(
      'Hello there.',
      (c) => chunks.push([...c]),
      new AbortController().signal,
    );
    await until(() => s.sent.length === 2);
    const config = JSON.parse(s.sent[0] ?? '{}');
    expect(config.model).toBe('tts-rt-v2');
    expect(config.audio_format).toBe('pcm_s16le');
    expect(config.sample_rate).toBe(24000);
    expect(config.api_key).toBe(KEY);
    const text = JSON.parse(s.sent[1] ?? '{}');
    expect(text).toEqual({ stream_id: config.stream_id, text: 'Hello there.', text_end: true });
    s.push({ stream_id: config.stream_id, audio: Buffer.from([1, 0, 2, 0]).toString('base64') });
    s.push({ stream_id: config.stream_id, audio: '', audio_end: true });
    await said;
    expect(chunks).toEqual([[1, 0, 2, 0]]);
    expect(s.closed).toBe(true);
  });

  it('an abort cancels the stream and resolves', async () => {
    const s = fakeSocket();
    const voice = createSonioxVoice({ apiKey: KEY, socketFactory: s.factory });
    const ctl = new AbortController();
    const said = voice.speak('Hello.', () => {}, ctl.signal);
    await until(() => s.sent.length === 2);
    ctl.abort();
    await said;
    expect(JSON.parse(s.sent[2] ?? '{}').cancel).toBe(true);
  });

  it('an error frame rejects without the key in the message', async () => {
    const s = fakeSocket();
    const voice = createSonioxVoice({ apiKey: KEY, socketFactory: s.factory });
    const said = voice.speak('Hello.', () => {}, new AbortController().signal);
    await until(() => s.sent.length === 2);
    s.push({ error_code: 401, error_message: 'bad key' });
    const err = await said.then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe('soniox tts: bad key');
    expect(err?.message).not.toContain(KEY);
  });
});

describe('ElevenLabs voice', () => {
  it('asks for Flash, 24 kHz PCM and no logging, and streams whole samples', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 0, 2]));
        c.enqueue(new Uint8Array([0, 3, 0]));
        c.close();
      },
    });
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const voice = createElevenLabsVoice({ apiKey: KEY, fetch: fakeFetch });
    const chunks: number[][] = [];
    await voice.speak('Hi.', (c) => chunks.push([...c]), new AbortController().signal);
    expect(calls[0]?.url).toBe(elevenLabsUrl());
    expect(calls[0]?.url).toContain('enable_logging=false');
    expect(calls[0]?.url).toContain('output_format=pcm_24000');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      text: 'Hi.',
      model_id: ELEVENLABS_MODEL,
    });
    expect(chunks).toEqual([
      [1, 0],
      [2, 0, 3, 0],
    ]);
  });

  it('a refused request names the status only', async () => {
    const fakeFetch = (async () =>
      new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const voice = createElevenLabsVoice({ apiKey: KEY, fetch: fakeFetch });
    const err = await voice
      .speak('Hi.', () => {}, new AbortController().signal)
      .then(
        () => null,
        (e: Error) => e,
      );
    expect(err?.message).toBe('elevenlabs: HTTP 401');
  });
});
