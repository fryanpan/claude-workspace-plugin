/**
 * The long-pause harness (`scripts/spoken-long-pause.ts`) run against setup 4
 * on the REAL server, with ElevenLabs stubbed: the stub's turn-taking calls a
 * question over after a set length of silence and asks this server's
 * custom-LLM route for the reply, as the real agent does.
 *
 * Two arms, so the verdict discriminates: a stub that ends a turn after 1s of
 * silence must be reported as cutting off a question with 2s pauses in it,
 * and one that waits 4s must be reported as hearing it whole. Both log their
 * timing row under setup 4. Pace 0: the stub counts silence in samples, so no
 * test waits out the pauses in real time.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingEnding, runLongPause, wavPcm16k } from '../../../scripts/spoken-long-pause.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { VOICE_AGENT_LLM_PATH } from '../src/spoken-reply/agent-llm.ts';
import { createElevenLabsAgent } from '../src/spoken-reply/elevenlabs-agent.ts';
import { SPOKEN_TIMINGS_FILE } from '../src/spoken-reply/timings.ts';

setDefaultTimeout(30_000);

const SECRET = 'fixture-llm-secret-0123456789abcdef';
const RATE = 16_000;
const SEGMENTS = ['Claude, give me a', 'status', 'update'];

/** Each segment a 500ms tone, with `pauseMs` of silence between them. */
function question(pauseMs: number): Uint8Array {
  const tone = (RATE * 500) / 1000;
  const gap = (RATE * pauseMs) / 1000;
  const total = SEGMENTS.length * tone + (SEGMENTS.length - 1) * gap;
  const pcm = new Int16Array(total);
  for (let s = 0; s < SEGMENTS.length; s++) {
    const at = s * (tone + gap);
    for (let i = 0; i < tone; i++) pcm[at + i] = Math.round(3000 * Math.sin(i / 4));
  }
  return new Uint8Array(pcm.buffer);
}

const rms = (b: Uint8Array) => {
  const v = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2));
  let sum = 0;
  for (const s of v) sum += s * s;
  return v.length ? Math.sqrt(sum / v.length) : 0;
};

/** ElevenLabs, stubbed: turn-taking by silence length, the reply by our route. */
function stubAgent(endpointSilenceMs: number, port: () => number) {
  return createElevenLabsAgent({
    apiKey: 'placeholder-key',
    agentId: 'agent_fixture01',
    socketFactory: (args) => {
      let token = '';
      let segments = 0;
      let inVoice = false;
      let silentMs = 0;
      let said: string[] = [];
      const down = (m: unknown) => args.onMessage(JSON.stringify(m));
      const endTurn = async () => {
        const text = said.join(' ');
        said = [];
        down({ type: 'user_transcript', user_transcription_event: { user_transcript: text } });
        const r = await fetch(`http://127.0.0.1:${port()}${VOICE_AGENT_LLM_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({
            stream: true,
            messages: [{ role: 'user', content: text }],
            elevenlabs_extra_body: { cw_session: token },
          }),
        });
        await r.text();
        down({ type: 'audio', audio_event: { audio_base_64: 'AAAAAA==', event_id: 1 } });
      };
      queueMicrotask(() => args.onOpen());
      return {
        send: (d) => {
          const m = JSON.parse(d) as Record<string, unknown>;
          if (m.type === 'conversation_initiation_client_data') {
            token = String((m.custom_llm_extra_body as { cw_session: string }).cw_session);
            down({
              type: 'conversation_initiation_metadata',
              conversation_initiation_metadata_event: {
                user_input_audio_format: 'pcm_16000',
                agent_output_audio_format: 'pcm_24000',
              },
            });
            return;
          }
          if (typeof m.user_audio_chunk !== 'string') return;
          const chunk = new Uint8Array(Buffer.from(m.user_audio_chunk, 'base64'));
          if (rms(chunk) > 200) {
            if (!inVoice) said.push(SEGMENTS[segments++] ?? '');
            inVoice = true;
            silentMs = 0;
            return;
          }
          inVoice = false;
          if (said.length === 0) return;
          silentMs += (chunk.byteLength / 2 / RATE) * 1000;
          if (silentMs >= endpointSilenceMs) void endTurn();
        },
        close: () => {},
      };
    },
  });
}

describe('the long-pause harness on setup 4', () => {
  const servers: ServerHandle[] = [];
  const dirs: string[] = [];
  let boardIds: string[] = [];

  beforeAll(async () => {
    for (const silence of [1000, 4000]) {
      const dataDir = mkdtempSync(join(tmpdir(), 'cw-long-pause-'));
      dirs.push(dataDir);
      const i = servers.length;
      const server = createServer({
        port: 0,
        dataDir,
        spokenReply: {
          listener: null,
          voices: { 1: null, 2: null },
          gemini: null,
          agent: { live: stubAgent(silence, () => servers[i]?.port ?? 0), llmSecret: SECRET },
        },
      });
      servers.push(server);
    }
    boardIds = await Promise.all(
      servers.map(async (s) => {
        const r = await fetch(`http://127.0.0.1:${s.port}/workspaces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Harborlight' }),
        });
        return ((await r.json()) as { workspace: { id: string } }).workspace.id;
      }),
    );
  });

  afterAll(async () => {
    for (const s of servers) await s.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const run = (i: number) =>
    runLongPause({
      wsBase: `ws://127.0.0.1:${servers[i]?.port}`,
      workspace: boardIds[i] ?? '',
      setup: 4,
      pcm: question(2000),
      expect: 'status update',
      pace: 0,
      trailingSilenceMs: 5000,
    });

  it('reports a turn-taker that ends inside a 2s pause as cutting the question off', async () => {
    const r = await run(0);
    expect(r.endedEarly).toBe(true);
    expect(r.question).toBe('Claude, give me a');
    expect(r.missing).toEqual(['status', 'update']);
    expect(r.cutOff).toBe(true);
  });

  it('reports one that waits out the pauses as hearing it whole, and logs it under setup 4', async () => {
    const r = await run(1);
    expect(r).toMatchObject({
      endedEarly: false,
      question: 'Claude, give me a status update',
      heard: ['Claude, give me a status update'],
      missing: [],
      cutOff: false,
      error: null,
    });
    expect(r.timing?.delayMs).toBeGreaterThanOrEqual(0);
    const rows = readFileSync(join(dirs[1] ?? '', SPOKEN_TIMINGS_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { setup: number; delayMs: number });
    expect(rows.at(-1)).toMatchObject({ setup: 4, delayMs: r.timing?.delayMs });
  });

  it('refuses a setup the server does not have', async () => {
    await expect(
      runLongPause({
        wsBase: `ws://127.0.0.1:${servers[0]?.port}`,
        workspace: boardIds[0] ?? '',
        setup: 2,
        pcm: question(0),
        pace: 0,
      }),
    ).rejects.toThrow('setup 2 is not available on this server (it has 4)');
  });

  it('reads the WAV `say` writes, and judges the ending word by word', () => {
    const pcm = question(0);
    const wav = new Uint8Array(44 + pcm.byteLength);
    const v = new DataView(wav.buffer);
    const put = (at: number, s: string) => wav.set(new TextEncoder().encode(s), at);
    put(0, 'RIFF');
    v.setUint32(4, 36 + pcm.byteLength, true);
    put(8, 'WAVE');
    put(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, RATE, true);
    v.setUint32(28, RATE * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    put(36, 'data');
    v.setUint32(40, pcm.byteLength, true);
    wav.set(pcm, 44);
    expect(wavPcm16k(wav)).toEqual(pcm);
    v.setUint32(24, 22_050, true);
    expect(() => wavPcm16k(wav)).toThrow('16 kHz mono 16-bit');
    expect(missingEnding('Claude, give me a status: up.', 'status update')).toEqual(['update']);
    expect(missingEnding('give me a status update.', 'status update')).toEqual([]);
  });
});
