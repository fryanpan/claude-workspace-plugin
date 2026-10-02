/**
 * The question a voice note is asked, played as the server says it: PCM16
 * mono chunks scheduled back to back on one AudioContext.
 *
 * Small on purpose — the widget's bundle is a hard budget — and so not the
 * board's spoken-reply player, which also stamps timings. `finish` always
 * calls back, even with no context or nothing queued, because the session
 * holds the microphone until it does.
 */

/** The slice of an AudioContext this uses — a fake in tests. */
export interface SpeakContext {
  readonly currentTime: number;
  readonly state: string;
  resume(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
  readonly destination: AudioNode;
}

export interface QuestionSpeaker {
  /** Resume inside a tap: Safari plays only from a context a gesture woke. */
  wake(): void;
  begin(sampleRate: number): void;
  push(bytes: Uint8Array): void;
  /** No more is coming; `done` once what was queued has played. */
  finish(done: () => void): void;
  stop(): void;
}

/** A little headroom so the first buffer is not scheduled in the past. */
const LEAD_S = 0.03;

export function createQuestionSpeaker(
  context: () => SpeakContext | null,
  timers: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): QuestionSpeaker {
  let ctx: SpeakContext | null = null;
  let rate = 24_000;
  let at = 0;
  let sources: AudioBufferSourceNode[] = [];
  let waiting: unknown = null;
  const open = () => {
    ctx ??= context();
    return ctx;
  };
  const stop = () => {
    if (waiting !== null) timers.clear(waiting);
    waiting = null;
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        // Already ended.
      }
    }
    sources = [];
    at = 0;
  };
  return {
    wake() {
      const c = open();
      if (c && c.state !== 'running') void c.resume().catch(() => {});
    },
    begin(sampleRate) {
      stop();
      rate = sampleRate;
      open();
    },
    push(bytes) {
      const c = ctx;
      const n = bytes.length >> 1;
      if (!c || n === 0) return;
      const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000;
      const buf = c.createBuffer(1, n, rate);
      buf.copyToChannel(samples, 0);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      at = Math.max(at, c.currentTime + LEAD_S);
      src.start(at);
      at += n / rate;
      sources.push(src);
    },
    finish(done) {
      const left = ctx ? Math.max(0, at - ctx.currentTime) : 0;
      waiting = timers.set(
        () => {
          waiting = null;
          sources = [];
          done();
        },
        // A breath after the last word, so its tail is not heard back.
        Math.ceil(left * 1000) + 250,
      );
    },
    stop,
  };
}
