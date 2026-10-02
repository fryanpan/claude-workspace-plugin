#!/usr/bin/env bun
/**
 * Does a pause in the middle of a question cut it off, and what does it cost?
 *
 * The long-pause test from PR 1171, made a command: a recorded question with
 * silences inside it is played into a board's spoken socket the way the
 * page's microphone sends it — tap mode, so the setup's own listener decides
 * where the question ends — followed by more silence, as a live microphone
 * keeps sending. It reports where the setup called the question over, what it
 * heard, and the same timing row the page sends, which the server logs under
 * that setup like any other turn.
 *
 * CUT OFF means the setup called the question over while voiced audio was
 * still to come, or the words it called over lack the `--expect` ending.
 *
 * The recording is 16 kHz mono 16-bit PCM in a WAV file. macOS makes one:
 *
 *   say -o pause3.wav --data-format=LEI16@16000 \
 *     "Claude, give me a [[slnc 3000]] status [[slnc 3000]] update"
 *   bun run scripts/spoken-long-pause.ts --workspace <id> --setup 4 \
 *     --wav pause3.wav --expect "status update"
 *
 * It spends whatever the chosen setup spends on one question; it plays no
 * audio aloud.
 */
import { readFileSync } from 'node:fs';

const SAMPLE_RATE = 16_000;
/** 100 ms of 16 kHz PCM16, the page's frame size. */
const FRAME_BYTES = 3200;
const FRAME_MS = 100;
/** A frame at or above this RMS counts as speech; `say`'s silence is zero. */
const VOICED_RMS = 200;

export interface LongPauseOptions {
  /** `ws://host:port` of the server. */
  wsBase: string;
  workspace: string;
  setup: number;
  /** 16 kHz mono PCM16 samples, little-endian. */
  pcm: Uint8Array;
  /** Words the called-over question must end with to count as whole. */
  expect?: string;
  /** 1 plays in real time; 0 sends as fast as the socket takes it. */
  pace?: number;
  /** Silence sent after the recording, as a live microphone keeps sending. */
  trailingSilenceMs?: number;
  /** How long to wait for the voice once the question is over. */
  replyTimeoutMs?: number;
}

export interface LongPauseResult {
  setup: number;
  /** The setup called the question over while voiced audio was still to come. */
  endedEarly: boolean;
  /** The question as called over (`turn-end`), or null if it never was. */
  question: string | null;
  /** Every `heard` the setup sent, in order: more than one is a split question. */
  heard: string[];
  /** The `--expect` words missing from the end of the question. */
  missing: string[];
  cutOff: boolean;
  /** The timing row sent to the server, or null when no voice came back. */
  timing: {
    delayMs: number;
    endpointMs?: number;
    replyMs?: number;
    audioMs?: number;
  } | null;
  error: string | null;
}

/** The PCM16 samples of a 16 kHz mono WAV, or a plain sentence of what is wrong. */
export function wavPcm16k(buf: Uint8Array): Uint8Array {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (at: number) => String.fromCharCode(...buf.subarray(at, at + 4));
  if (buf.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let at = 12;
  let format: { channels: number; rate: number; bits: number } | null = null;
  while (at + 8 <= buf.byteLength) {
    const id = tag(at);
    const size = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = {
        channels: v.getUint16(body + 2, true),
        rate: v.getUint32(body + 4, true),
        bits: v.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!format || format.channels !== 1 || format.rate !== SAMPLE_RATE || format.bits !== 16) {
        throw new Error('the WAV must be 16 kHz mono 16-bit (say --data-format=LEI16@16000)');
      }
      return buf.slice(body, Math.min(body + size, buf.byteLength));
    }
    at = body + size + (size % 2);
  }
  throw new Error('the WAV has no data chunk');
}

function frameRms(frame: Uint8Array): number {
  const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let sum = 0;
  const n = Math.floor(frame.byteLength / 2);
  for (let i = 0; i < n; i++) {
    const s = v.getInt16(i * 2, true);
    sum += s * s;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

function frames(pcm: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < pcm.byteLength; at += FRAME_BYTES) {
    const f = new Uint8Array(FRAME_BYTES);
    f.set(pcm.subarray(at, at + FRAME_BYTES));
    out.push(f);
  }
  return out;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** The `expect` words not at the end of `question`, in order. */
export function missingEnding(question: string | null, expect: string | undefined): string[] {
  if (!expect) return [];
  const want = words(expect);
  const got = words(question ?? '');
  const tail = got.slice(-want.length);
  return want.filter((w, i) => tail[i] !== w);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runLongPause(o: LongPauseOptions): Promise<LongPauseResult> {
  const pace = o.pace ?? 1;
  const speech = frames(o.pcm);
  let lastVoiced = -1;
  for (const [i, f] of speech.entries()) if (frameRms(f) >= VOICED_RMS) lastVoiced = i;
  const silence = Math.ceil((o.trailingSilenceMs ?? 8000) / FRAME_MS);
  const all = [...speech, ...Array.from({ length: silence }, () => new Uint8Array(FRAME_BYTES))];

  const ws = new WebSocket(
    `${o.wsBase}/workspaces/${encodeURIComponent(o.workspace)}/voice/converse`,
  );
  ws.binaryType = 'arraybuffer';
  const heard: string[] = [];
  let question: string | null = null;
  let turnEndAt: number | null = null;
  let turnEndFrame: number | null = null;
  let replyAt: number | null = null;
  let audioAt: number | null = null;
  let audioEnded = false;
  let error: string | null = null;
  let sent = 0;
  let ready: (setups: number[]) => void = () => {};
  const readyP = new Promise<number[]>((r) => {
    ready = r;
  });
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return;
    const m = JSON.parse(ev.data) as Record<string, unknown>;
    const now = performance.now();
    if (m.type === 'ready') ready((m.setups as number[]) ?? []);
    else if (m.type === 'heard') heard.push(String(m.text));
    else if (m.type === 'turn-end' && turnEndAt === null) {
      turnEndAt = now;
      turnEndFrame = sent - 1;
      question = String(m.text);
    } else if (m.type === 'reply' && replyAt === null) replyAt = now;
    else if (m.type === 'audio-start' && audioAt === null) audioAt = now;
    else if (m.type === 'audio-end') audioEnded = true;
    else if (m.type === 'error') error = String(m.message);
  });
  const closed = new Promise<void>((r) => ws.addEventListener('close', () => r()));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('the spoken socket did not open')));
  });
  const setups = await readyP;
  if (!setups.includes(o.setup)) {
    ws.close();
    throw new Error(
      `setup ${o.setup} is not available on this server (it has ${setups.join(', ') || 'none'})`,
    );
  }

  ws.send(
    JSON.stringify({
      type: 'start',
      setup: o.setup,
      mode: 'tap',
      author: { id: 'long-pause-harness', name: 'long-pause harness', kind: 'known' },
    }),
  );
  let lastVoiceAt: number | null = null;
  const t0 = performance.now();
  for (const [i, f] of all.entries()) {
    if (error || (turnEndAt !== null && i > lastVoiced)) break;
    ws.send(f);
    sent = i + 1;
    if (i === lastVoiced) lastVoiceAt = performance.now();
    if (pace > 0) await sleep(Math.max(0, t0 + sent * FRAME_MS * pace - performance.now()));
    else await sleep(0);
  }
  const deadline = performance.now() + (o.replyTimeoutMs ?? 20_000);
  while (!error && !audioEnded && turnEndAt !== null && performance.now() < deadline) {
    await sleep(20);
  }

  let timing: LongPauseResult['timing'] = null;
  const end: number | null = lastVoiceAt;
  if (audioAt !== null && end !== null) {
    const a: number = audioAt;
    const te: number | null = turnEndAt;
    const rp: number | null = replyAt;
    timing = {
      delayMs: Math.round(Math.max(0, a - end)),
      ...(te !== null ? { endpointMs: Math.round(Math.max(0, te - end)) } : {}),
      ...(te !== null && rp !== null ? { replyMs: Math.round(Math.max(0, rp - te)) } : {}),
      ...(rp !== null ? { audioMs: Math.round(Math.max(0, a - rp)) } : {}),
    };
    ws.send(JSON.stringify({ type: 'timing', ...timing }));
    await sleep(200);
  }
  ws.close();
  await closed;

  const endedEarly = turnEndFrame !== null && turnEndFrame < lastVoiced;
  const missing = missingEnding(question, o.expect);
  return {
    setup: o.setup,
    endedEarly,
    question,
    heard,
    missing,
    cutOff: endedEarly || missing.length > 0,
    timing,
    error: error ?? (question === null ? 'the setup never called the question over' : null),
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const workspace = arg('workspace');
  const wav = arg('wav');
  const setup = Number(arg('setup') ?? '4');
  if (!workspace || !wav) {
    console.error(
      'usage: bun run scripts/spoken-long-pause.ts --workspace <id> --wav <file> [--setup 4] [--expect "status update"] [--base ws://127.0.0.1:8787]',
    );
    process.exit(2);
  }
  const r = await runLongPause({
    wsBase: arg('base') ?? 'ws://127.0.0.1:8787',
    workspace,
    setup,
    pcm: wavPcm16k(new Uint8Array(readFileSync(wav))),
    expect: arg('expect'),
  });
  console.log(JSON.stringify(r));
  const verdict = r.cutOff
    ? `CUT OFF${r.endedEarly ? ' (called over while still speaking)' : ''}${r.missing.length ? ` (missing: ${r.missing.join(' ')})` : ''}`
    : 'whole';
  console.log(
    `setup ${r.setup}: ${verdict}; heard "${r.question ?? ''}"` +
      (r.timing
        ? `; delay ${r.timing.delayMs}ms, endpoint ${r.timing.endpointMs ?? '?'}ms`
        : '; no voice came back') +
      (r.error ? `; ${r.error}` : ''),
  );
  process.exit(r.error ? 1 : 0);
}
