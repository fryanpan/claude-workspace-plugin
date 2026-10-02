/**
 * A bot that may speak, as Recall is asked for one: the create body carries
 * the silent clip that turns audio output on, and `outputAudio` sends the
 * documented body to the documented path. A stubbed `fetch`; no network.
 */
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_BOT_NAME,
  OUTPUT_AUDIO_MAX_B64,
  type RecallConfig,
  buildCreateBotBody,
  createRecallClient,
  silentMp3,
} from '../src/recall.ts';

const FAKE_KEY = 'test-key-not-a-credential';
const config: RecallConfig = {
  region: 'us-west-2',
  publicWsBase: 'wss://example.test',
  retentionHours: 24,
  separateStreams: true,
  botName: DEFAULT_BOT_NAME,
};
const ARGS = {
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  realtimeUrl: 'wss://example.test/recall/t',
};

describe('a bot that may speak', () => {
  it('is created with a silent clip as its automatic audio, and only then', () => {
    const speaking = buildCreateBotBody(config, { ...ARGS, speaks: true });
    const data = (
      speaking.automatic_audio_output as {
        in_call_recording: { data: { kind: string; b64_data: string } };
      }
    ).in_call_recording.data;
    expect(data.kind).toBe('mp3');
    expect([...Buffer.from(data.b64_data, 'base64')]).toEqual([...silentMp3()]);
    expect(buildCreateBotBody(config, ARGS).automatic_audio_output).toBeUndefined();
  });

  it('is given half a second of MPEG-1 Layer III frames that hold no sound', () => {
    const mp3 = silentMp3();
    // 32 kbps at 32 kHz: 144 bytes a frame, 1152 samples (36ms) each.
    expect(mp3.length).toBe(14 * 144);
    for (let at = 0; at < mp3.length; at += 144) {
      expect([...mp3.subarray(at, at + 4)]).toEqual([0xff, 0xfb, 0x18, 0xc0]);
      expect(mp3.subarray(at + 4, at + 144).every((b) => b === 0)).toBe(true);
    }
  });
});

describe('playing audio into the call', () => {
  function client(status = 200) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = createRecallClient({
      apiKey: FAKE_KEY,
      config,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(status === 200 ? '{"id":"bot_1"}' : '{"detail":"not in call"}', {
          status,
        });
      },
    });
    if (!c) throw new Error('no client');
    return { c, calls };
  }

  it('posts the MP3 as base64 to the bot’s output_audio path', async () => {
    const { c, calls } = client();
    await c.outputAudio('bot_1', new Uint8Array([1, 2, 3]));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://us-west-2.recall.ai/api/v1/bot/bot_1/output_audio/');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ kind: 'mp3', b64_data: 'AQID' });
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(FAKE_KEY);
  });

  it('throws Recall’s refusal, and never sends a clip over the size cap', async () => {
    const refused = client(400);
    await expect(refused.c.outputAudio('bot_1', new Uint8Array([1]))).rejects.toThrow(
      'not in call',
    );
    const big = client();
    const tooLong = new Uint8Array(Math.ceil((OUTPUT_AUDIO_MAX_B64 / 4) * 3) + 3);
    await expect(big.c.outputAudio('bot_1', tooLong)).rejects.toThrow('too long');
    expect(big.calls).toHaveLength(0);
  });
});
