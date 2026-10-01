/**
 * The board mic's spoken reply: the wire between the board page and the
 * server's `WS /workspaces/<ws>/voice/converse`.
 *
 * In `core` because both ends read it and neither can import the other. The
 * page streams the meeting capture's PCM (16 kHz mono PCM16) up as binary
 * frames and sends the JSON below as text frames; the server answers with
 * JSON, and with the reply's voice as binary PCM16 at `SPOKEN_OUTPUT_RATE`
 * between an `audio-start` and an `audio-end`.
 *
 * FOUR SETUPS behind one switch, so they can be heard side by side on the
 * same board (the voice plan, "Which voice API"):
 *
 *   1  Soniox listens and Soniox speaks.
 *   2  Soniox listens and ElevenLabs Flash speaks.
 *   3  Gemini Live hears and speaks, and asks the board what to say.
 *   4  ElevenLabs Agents hears, takes turns and speaks, and asks this
 *      server's custom-LLM route what to say.
 *
 * In every setup the words of the reply come from the board mic's own router
 * (`voice.ts`), so what a setup changes is the ears and the voice, not the
 * answer.
 */

export type SpokenSetup = 1 | 2 | 3 | 4;
export const SPOKEN_SETUPS: readonly SpokenSetup[] = [1, 2, 3, 4];

/** A setup's number as a JSON key. */
export type SpokenSetupKey = '1' | '2' | '3' | '4';

export function spokenSetupKey(s: SpokenSetup): SpokenSetupKey {
  return String(s) as SpokenSetupKey;
}

export const SPOKEN_SETUP_NAMES: Record<SpokenSetup, string> = {
  1: 'Soniox alone',
  2: 'Soniox + ElevenLabs',
  3: 'Gemini Live',
  4: 'ElevenLabs Agents',
};

/** The switch's tooltips: who hears and who speaks. */
export const SPOKEN_SETUP_TITLES: Record<SpokenSetup, string> = {
  1: 'Soniox listens and speaks',
  2: 'Soniox listens, ElevenLabs Flash speaks',
  3: 'Gemini Live hears and speaks',
  4: 'ElevenLabs Agents hears, takes turns and speaks',
};

/**
 * How a question ends. `hold`: when the mic is released. `tap`: when the
 * listener decides the speaker has finished — the end-of-speech detection the
 * long-pause test is about.
 */
export type SpokenMode = 'hold' | 'tap';

/** The rate setups 1-3's voice arrives at. All three vendors offer 24 kHz
 *  PCM16, so the page plays one format whichever setup spoke. Setup 4 plays
 *  at the rate its agent is configured for, named in `audio-start`. */
export const SPOKEN_OUTPUT_RATE = 24_000;

/** The longest a spoken part may be, in words. The plan's first risk is
 *  talking too much; this is the hard cap under the two-sentence rule. */
export const SPOKEN_MAX_WORDS = 40;

export interface SpokenAuthor {
  id: string;
  name: string;
  kind?: string;
}

export type SpokenClientMessage =
  | {
      type: 'start';
      setup: SpokenSetup;
      mode: SpokenMode;
      /** Where the speaker is: the same object `POST /voice` takes. Parsed by
       *  the server's own `parseVoiceContext`, never trusted here. */
      context?: unknown;
      author?: SpokenAuthor;
    }
  | { type: 'end' }
  | { type: 'stop' }
  /** A choice tapped instead of said: answered as if it had been heard, on
   *  the setup the last `start` named. */
  | { type: 'say'; text: string }
  | {
      type: 'timing';
      /** End of the question to the first spoken word, as the page heard it. */
      delayMs: number;
      /** End of the question to the listener calling it over. */
      endpointMs?: number;
      /** Listener calling it over to the written reply arriving. */
      replyMs?: number;
      /** Written reply arriving to the first spoken word. */
      audioMs?: number;
    };

export interface SpokenTimingRow {
  n: number;
  medianMs: number;
  p90Ms: number;
  lastMs: number;
}

/** Per setup, keyed by the setup's number as a string (JSON keys). */
export type SpokenTimingSummary = Partial<Record<SpokenSetupKey, SpokenTimingRow>>;

/**
 * A setup the server has the keys for but will not run yet, with the one
 * line that says why — shown on the page when it is chosen. Keyed like
 * `SpokenTimingSummary`.
 */
export type SpokenHeldSetups = Partial<Record<SpokenSetupKey, string>>;

export type SpokenServerMessage =
  | { type: 'ready'; setups: SpokenSetup[]; held?: SpokenHeldSetups; timings: SpokenTimingSummary }
  | { type: 'heard'; text: string }
  | { type: 'turn-end'; text: string }
  | {
      type: 'reply';
      /** Said aloud: the first two sentences, or the one question. Empty when
       *  nothing was heard. */
      spoken: string;
      /** Written only, one line each, below the spoken part. */
      detail: string[];
      /** The spoken part is a question, and the page waits for its answer. */
      asking: boolean;
      /** When asking, the answers the page may offer as buttons. */
      choices?: string[];
      /** Which route answered — the router's own word, or `none`. */
      route: string;
      navigate?: string;
    }
  | { type: 'audio-start'; sampleRate: number }
  | { type: 'audio-end' }
  | { type: 'timings'; summary: SpokenTimingSummary }
  | { type: 'error'; message: string };

const MAX_TIMING_MS = 120_000;
const MAX_AUTHOR_FIELD = 200;
const MAX_SAY_CHARS = 200;

function isSetup(v: unknown): v is SpokenSetup {
  return v === 1 || v === 2 || v === 3 || v === 4;
}

function timingField(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TIMING_MS
    ? Math.round(v)
    : undefined;
}

function authorOf(raw: unknown): SpokenAuthor | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const a = raw as Record<string, unknown>;
  const id = typeof a.id === 'string' ? a.id.trim().slice(0, MAX_AUTHOR_FIELD) : '';
  const name = typeof a.name === 'string' ? a.name.trim().slice(0, MAX_AUTHOR_FIELD) : '';
  if (!id || !name) return undefined;
  const kind = typeof a.kind === 'string' ? a.kind.slice(0, 40) : undefined;
  return { id, name, ...(kind ? { kind } : {}) };
}

/**
 * A text frame from the page, or null. Everything the server acts on is
 * checked here: an unknown type, a setup outside 1–4, a timing that is not a
 * plausible number of milliseconds — all null, and the server ignores null.
 */
export function parseSpokenClientMessage(text: string): SpokenClientMessage | null {
  if (text.length > 20_000) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'start': {
      if (!isSetup(m.setup)) return null;
      const mode: SpokenMode = m.mode === 'tap' ? 'tap' : 'hold';
      const author = authorOf(m.author);
      return {
        type: 'start',
        setup: m.setup,
        mode,
        ...(m.context !== undefined ? { context: m.context } : {}),
        ...(author ? { author } : {}),
      };
    }
    case 'end':
      return { type: 'end' };
    case 'stop':
      return { type: 'stop' };
    case 'say': {
      const text = typeof m.text === 'string' ? m.text.trim().slice(0, MAX_SAY_CHARS) : '';
      return text ? { type: 'say', text } : null;
    }
    case 'timing': {
      const delayMs = timingField(m.delayMs);
      if (delayMs === undefined) return null;
      const endpointMs = timingField(m.endpointMs);
      const replyMs = timingField(m.replyMs);
      const audioMs = timingField(m.audioMs);
      return {
        type: 'timing',
        delayMs,
        ...(endpointMs !== undefined ? { endpointMs } : {}),
        ...(replyMs !== undefined ? { replyMs } : {}),
        ...(audioMs !== undefined ? { audioMs } : {}),
      };
    }
    default:
      return null;
  }
}

/** A server frame, or null — the page's half of the same check. */
export function parseSpokenServerMessage(text: string): SpokenServerMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const t = (raw as { type?: unknown }).type;
  const known = [
    'ready',
    'heard',
    'turn-end',
    'reply',
    'audio-start',
    'audio-end',
    'timings',
    'error',
  ];
  return typeof t === 'string' && known.includes(t) ? (raw as SpokenServerMessage) : null;
}
