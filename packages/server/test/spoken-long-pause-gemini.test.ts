/**
 * The long-pause harness (`scripts/spoken-long-pause.ts`) run against setup 3
 * on the REAL server, with Gemini Live stubbed: the stub reads the
 * `silenceDurationMs` out of the setup frame this server actually sends,
 * calls the question over after that much silence, as Gemini's own activity
 * detection does, and asks the board through `ask_board`.
 *
 * Two arms, so the verdict discriminates. Since Bryan's 2 Oct request (the
 * turn ends on its own about 500 ms after the last word) the setup frame asks
 * for 500 ms of silence, which is a trade the harness states rather than
 * hides: the stub obeying it hears a question with 300 ms gaps whole and cuts
 * one with 3s pauses off, and the same stub forced to the 3,500 ms the frame
 * used to send hears the 3s question whole.
 * Pace 0: the stub counts silence in samples, so no test waits out a pause.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLongPause } from '../../../scripts/spoken-long-pause.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ASK_BOARD, createGeminiLive } from '../src/spoken-reply/gemini-live.ts';

setDefaultTimeout(30_000);

const RATE = 16_000;
const SEGMENTS = ['Claude, give me a', 'status', 'update'];

/** Each segment a 500ms tone, with `pauseMs` of silence between them. */
function question(pauseMs: number): Uint8Array {
  const tone = (RATE * 500) / 1000;
  const gap = (RATE * pauseMs) / 1000;
  const pcm = new Int16Array(SEGMENTS.length * tone + (SEGMENTS.length - 1) * gap);
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

/** Gemini Live, stubbed: its activity detection ends a turn after the
 *  setup frame's `silenceDurationMs`, unless `forceSilenceMs` overrides it. */
function stubGemini(forceSilenceMs?: number) {
  return createGeminiLive({
    apiKey: 'placeholder-key',
    socketFactory: (args) => {
      let silenceCap = Number.POSITIVE_INFINITY;
      let segments = 0;
      let inVoice = false;
      let silentMs = 0;
      let said: string[] = [];
      let calls = 0;
      const down = (m: unknown) => args.onMessage(JSON.stringify(m));
      queueMicrotask(() => args.onOpen());
      return {
        send: (d) => {
          const m = JSON.parse(d) as Record<string, unknown>;
          const setup = m.setup as
            | {
                realtimeInputConfig?: {
                  automaticActivityDetection?: { silenceDurationMs?: number };
                };
              }
            | undefined;
          if (setup) {
            const cap = setup.realtimeInputConfig?.automaticActivityDetection?.silenceDurationMs;
            silenceCap = forceSilenceMs ?? cap ?? silenceCap;
            down({ setupComplete: {} });
            return;
          }
          if (m.toolResponse) {
            const pcm = Buffer.from(new Int16Array(240).fill(2000).buffer).toString('base64');
            down({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm } }] } } });
            down({ serverContent: { turnComplete: true } });
            return;
          }
          const data = (m.realtimeInput as { audio?: { data?: string } } | undefined)?.audio?.data;
          if (typeof data !== 'string') return;
          const chunk = new Uint8Array(Buffer.from(data, 'base64'));
          if (rms(chunk) > 200) {
            if (!inVoice) said.push(SEGMENTS[segments++] ?? '');
            inVoice = true;
            silentMs = 0;
            return;
          }
          inVoice = false;
          if (said.length === 0) return;
          silentMs += (chunk.byteLength / 2 / RATE) * 1000;
          if (silentMs < silenceCap) return;
          const text = said.join(' ');
          said = [];
          down({ serverContent: { inputTranscription: { text } } });
          down({
            toolCall: {
              functionCalls: [{ id: `call-${++calls}`, name: ASK_BOARD, args: { request: text } }],
            },
          });
        },
        close: () => {},
      };
    },
  });
}

describe('the long-pause harness on setup 3', () => {
  const servers: ServerHandle[] = [];
  const dirs: string[] = [];
  let boardIds: string[] = [];

  beforeAll(async () => {
    for (const force of [3500, undefined]) {
      const dataDir = mkdtempSync(join(tmpdir(), 'cw-long-pause-gemini-'));
      dirs.push(dataDir);
      servers.push(
        createServer({
          port: 0,
          dataDir,
          spokenReply: {
            listener: null,
            voices: { 1: null, 2: null },
            gemini: stubGemini(force),
          },
        }),
      );
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

  const run = (i: number, pauseMs: number) =>
    runLongPause({
      wsBase: `ws://127.0.0.1:${servers[i]?.port}`,
      workspace: boardIds[i] ?? '',
      setup: 3,
      pcm: question(pauseMs),
      expect: 'status update',
      pace: 0,
      trailingSilenceMs: 8000,
    });

  it('the old 3,500 ms cap heard a question with 3s pauses whole', async () => {
    const r = await run(0, 3000);
    expect(r).toMatchObject({ endedEarly: false, cutOff: false, error: null });
  });

  it('the setup frame this server sends cuts a 3s pause off: the stated trade', async () => {
    const r = await run(1, 3000);
    expect(r.endedEarly).toBe(true);
    expect(r.question).toBe('Claude, give me a');
    expect(r.cutOff).toBe(true);
  });

  it('and hears a question with 300 ms gaps whole', async () => {
    const r = await run(1, 300);
    expect(r).toMatchObject({
      endedEarly: false,
      question: 'Claude, give me a status update',
      missing: [],
      cutOff: false,
      error: null,
    });
    expect(r.timing?.delayMs).toBeGreaterThanOrEqual(0);
  });
});
