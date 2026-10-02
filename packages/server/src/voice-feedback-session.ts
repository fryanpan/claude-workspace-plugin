/**
 * The state of one voice feedback session, as the relay
 * (`voice-feedback-relay.ts`) keeps it: the socket, the recording, the words
 * heard (`voice-feedback-turns.ts`) and the notes made from them. Types, and
 * the one constructor; the relay's tests drive every field.
 */
import type { User, VoiceTarget, WriteVia } from '@claude-workspaces/core';
import type { TranscriptionSession } from './transcribe.ts';
import type { PendingAsk } from './voice-feedback-ask.ts';
import type { VoiceLog, WavWriter } from './voice-feedback-store.ts';
import { VoiceTurns } from './voice-feedback-turns.ts';

/** The slice of a Bun `ServerWebSocket` this module needs. */
export interface VoiceWs {
  data: {
    docId: string;
    workspaceId?: string;
    readOnly?: boolean;
    /** The identity the upgrade proved, if any — never what a body claimed. */
    author?: User | null;
    /** Opened from inside a served mock — see `WriteVia`. */
    via?: WriteVia;
  };
  /** Text frames, and the binary audio of a question said aloud. */
  send(payload: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface VoiceTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface LiveComment {
  key: string;
  text: string;
  target: number | null;
  raw: string;
  startMs: number;
  endMs: number;
  fixed: boolean;
  final: boolean;
  /** Tapped to add to, and no tick has grown it since. */
  chosen?: boolean;
  /** The thread the page posted it as, once the page says. */
  threadId?: string;
  /** It has had its one question. */
  asked?: boolean;
  /** The reading the person chose when asked what it meant. */
  clarified?: string;
}

export interface Session {
  ws: VoiceWs;
  engine: TranscriptionSession | null;
  wav: WavWriter;
  log: VoiceLog;
  segment: number;
  /** Who is speaking, for notes the server writes after the page has gone. */
  author: User | null;
  targets: VoiceTarget[];
  turns: VoiceTurns;
  comments: Map<string, LiveComment>;
  open: LiveComment | null;
  pinned: number | null | undefined;
  seq: number;
  /** Audio position (ms) where the words not yet ticked begin. */
  cursorMs: number;
  timer: unknown;
  /** When the oldest word no tick has taken was heard; null when none waits. */
  since: number | null;
  /** The tick in flight, if any — one at a time. */
  inflight: Promise<void> | null;
  /** Taps waiting on the words before them to be folded, in order. */
  switching: Promise<void>;
  /** The one ending: a Stop and a close that race share it. */
  ending: Promise<void> | null;
  closed: boolean;
  /** The one question waiting for an answer (`voice-feedback-question.ts`). */
  ask: PendingAsk | null;
  /** The question being said aloud, to stop when it is answered. */
  speaking: AbortController | null;
  usd: number;
  ticks: number;
}

/** A session as it starts: nothing heard, no note, no question. */
export function newSession(
  first: Pick<Session, 'ws' | 'wav' | 'log' | 'segment' | 'author' | 'targets'>,
): Session {
  return {
    ...first,
    engine: null,
    turns: new VoiceTurns(),
    comments: new Map(),
    open: null,
    pinned: undefined,
    seq: 0,
    cursorMs: 0,
    timer: null,
    since: null,
    inflight: null,
    switching: Promise.resolve(),
    ending: null,
    closed: false,
    ask: null,
    speaking: null,
    usd: 0,
    ticks: 0,
  };
}
