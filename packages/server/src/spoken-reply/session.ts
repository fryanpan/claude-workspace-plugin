/**
 * One reply panel's socket: hear a question, answer it, say the answer.
 *
 * A turn starts with the page's `start` and the microphone's PCM behind it.
 *
 *  - Setups 1 and 2 hear with Soniox's real-time listener. In `hold` mode the
 *    question ends when the page sends `end`; in `tap` mode it ends at the
 *    listener's own end of speech — the detection the long-pause test is
 *    about, pushed to its latest (`max_endpoint_delay_ms` 3000) so a person
 *    thinking mid-sentence is less likely to be cut off. The words go to the
 *    answerer (the board mic's router), and the spoken part goes to the
 *    setup's voice: Soniox TTS for 1, ElevenLabs Flash for 2.
 *  - Setup 3 streams the same PCM to Gemini Live, which calls back into the
 *    same answerer through its `ask_board` tool and speaks the result.
 *
 * `stop` is the page saying the speaker cut in: the voice is aborted at once
 * and whatever it had not sent is never sent.
 *
 * Every callback checks the turn it belongs to, so a slow engine answering an
 * old turn cannot speak over a new one.
 */
import {
  SPOKEN_OUTPUT_RATE,
  SPOKEN_SETUPS,
  type SpokenClientMessage,
  type SpokenHeldSetups,
  type SpokenMode,
  type SpokenServerMessage,
  type SpokenSetup,
  parseSpokenClientMessage,
} from '@claude-workspaces/core/spoken-reply';
import type { TranscriptionEngine, TranscriptionSession } from '../transcribe.ts';
import type { VoiceActor } from '../voice-action.ts';
import type { VoiceContext } from '../voice-prompt.ts';
import type { SpokenAnswer, SpokenAnswerer } from './answer.ts';
import type { GeminiLive, GeminiLiveSession } from './gemini-live.ts';
import type { SpokenTimings } from './timings.ts';
import type { SpokenVoice } from './tts.ts';

export const SPOKEN_INPUT_RATE = 16_000;

/** The listener's tuning for a spoken question: end of speech called as late
 *  as Soniox allows. Level 2 is already the adapter's default. */
export const SPOKEN_LISTEN_TUNING = { max_endpoint_delay_ms: 3000 };

/** Audio held while the listener connects: 20s of 50ms frames. */
const MAX_BUFFERED_FRAMES = 400;

export interface SpokenEngines {
  /** Setups 1 and 2's ears. */
  listener: TranscriptionEngine | null;
  voices: { 1: SpokenVoice | null; 2: SpokenVoice | null };
  gemini: GeminiLive | null;
  /** Built but not run yet, and why — see `SpokenHeldSetups`. */
  held?: SpokenHeldSetups;
}

export function availableSetups(e: SpokenEngines): SpokenSetup[] {
  return SPOKEN_SETUPS.filter((s) =>
    s === 3 ? e.gemini !== null : e.listener !== null && e.voices[s] !== null,
  );
}

export interface SpokenSessionDeps {
  engines: SpokenEngines;
  answerer: SpokenAnswerer;
  timings: SpokenTimings;
  /** The identity the upgrade proved; the page's claim is used without one. */
  provenActor: VoiceActor | null;
  readOnly: boolean;
  parseContext(raw: unknown): VoiceContext | undefined;
  sendJson(msg: SpokenServerMessage): void;
  sendAudio(pcm: Uint8Array): void;
}

function replyMessage(a: SpokenAnswer): SpokenServerMessage {
  return {
    type: 'reply',
    spoken: a.spoken,
    detail: a.detail,
    asking: a.asking,
    ...(a.choices ? { choices: a.choices } : {}),
    route: a.route,
    ...(a.navigate ? { navigate: a.navigate } : {}),
  };
}

const NOBODY: VoiceActor = { id: 'voice-unknown', name: 'unknown', kind: 'known' };

export class SpokenSession {
  private turn = 0;
  private setup: SpokenSetup = 1;
  private mode: SpokenMode = 'hold';
  private context: VoiceContext | undefined;
  private actor: VoiceActor = NOBODY;

  // Setups 1 and 2: the listener for the current turn.
  private stt: TranscriptionSession | null = null;
  private sttOpening: Promise<TranscriptionSession | null> | null = null;
  private buffered: Uint8Array[] = [];
  private finals: string[] = [];
  private finishing = false;
  private speaking: AbortController | null = null;

  // Setup 3: one Gemini session per socket, reopened only if the mode changes.
  private gemini: GeminiLiveSession | null = null;
  private geminiManual = false;
  private geminiOpening: Promise<GeminiLiveSession | null> | null = null;
  private heardText = '';
  private saidText = '';
  private replied = false;
  private audioOpen = false;
  private dropAudio = false;

  constructor(private readonly deps: SpokenSessionDeps) {}

  open(): void {
    this.deps.sendJson({
      type: 'ready',
      setups: availableSetups(this.deps.engines),
      ...(this.deps.engines.held ? { held: this.deps.engines.held } : {}),
      timings: this.deps.timings.summary(),
    });
  }

  onText(text: string): void {
    const msg = parseSpokenClientMessage(text);
    if (!msg) return;
    switch (msg.type) {
      case 'start':
        this.start(msg);
        return;
      case 'end':
        this.end();
        return;
      case 'stop':
        this.stopSpeaking();
        return;
      case 'say':
        this.say(msg.text);
        return;
      case 'timing':
        this.deps.timings.record({
          setup: this.setup,
          delayMs: msg.delayMs,
          ...(msg.endpointMs !== undefined ? { endpointMs: msg.endpointMs } : {}),
          ...(msg.replyMs !== undefined ? { replyMs: msg.replyMs } : {}),
          ...(msg.audioMs !== undefined ? { audioMs: msg.audioMs } : {}),
          at: Date.now(),
        });
        this.deps.sendJson({ type: 'timings', summary: this.deps.timings.summary() });
        return;
    }
  }

  onAudio(pcm: Uint8Array): void {
    if (this.setup === 3) {
      if (this.gemini) this.gemini.sendAudio(pcm);
      else if (this.geminiOpening && this.buffered.length < MAX_BUFFERED_FRAMES) {
        this.buffered.push(pcm.slice());
      }
      return;
    }
    if (this.stt) this.stt.send(pcm);
    else if (this.sttOpening && this.buffered.length < MAX_BUFFERED_FRAMES) {
      this.buffered.push(pcm.slice());
    }
  }

  close(): void {
    this.turn++;
    this.stopSpeaking();
    this.dropListener();
    this.gemini?.close();
    this.gemini = null;
  }

  private start(msg: Extract<SpokenClientMessage, { type: 'start' }>): void {
    if (this.deps.readOnly) {
      this.deps.sendJson({ type: 'error', message: 'Sign in to use the mic.' });
      return;
    }
    if (!availableSetups(this.deps.engines).includes(msg.setup)) {
      this.deps.sendJson({
        type: 'error',
        message:
          this.deps.engines.held?.[String(msg.setup) as '1' | '2' | '3'] ??
          `Setup ${msg.setup} is not set up on this server.`,
      });
      return;
    }
    this.stopSpeaking();
    this.dropListener();
    this.turn++;
    this.setup = msg.setup;
    this.mode = msg.mode;
    this.context = this.deps.parseContext(msg.context);
    this.actor = this.deps.provenActor ?? msg.author ?? NOBODY;
    if (msg.setup === 3) this.startGemini();
    else this.startListening();
  }

  private end(): void {
    if (this.setup === 3) {
      void (this.gemini ? Promise.resolve(this.gemini) : this.geminiOpening)?.then((g) => {
        if (!g) return;
        if (this.geminiManual) g.activityEnd();
        else g.endStream();
      });
      return;
    }
    void this.finishListening(this.turn);
  }

  private stopSpeaking(): void {
    this.speaking?.abort();
    this.speaking = null;
    if (this.setup === 3) {
      this.dropAudio = true;
      if (this.audioOpen) this.deps.sendJson({ type: 'audio-end' });
      this.audioOpen = false;
    }
  }

  // ── Setups 1 and 2 ───────────────────────────────────────────────────────

  private dropListener(): void {
    const s = this.stt;
    this.stt = null;
    this.sttOpening = null;
    this.buffered = [];
    this.finals = [];
    this.finishing = false;
    void s?.close().catch(() => {});
  }

  private startListening(): void {
    const listener = this.deps.engines.listener;
    if (!listener) return;
    const turn = this.turn;
    const opening = listener
      .open({
        sampleRate: SPOKEN_INPUT_RATE,
        detectSpeakers: false,
        tuning: SPOKEN_LISTEN_TUNING,
        onTurn: (t) => {
          if (turn !== this.turn) return;
          if (t.final) this.finals.push(t.text);
          const text = [...this.finals, ...(t.final ? [] : [t.text])].join(' ').trim();
          if (text) this.deps.sendJson({ type: 'heard', text });
          if (t.final && this.mode === 'tap') void this.finishListening(turn);
        },
        onError: (message) => {
          if (turn === this.turn) this.deps.sendJson({ type: 'error', message });
        },
      })
      .then(
        (session) => {
          if (turn !== this.turn) {
            void session.close().catch(() => {});
            return null;
          }
          this.stt = session;
          for (const pcm of this.buffered) session.send(pcm);
          this.buffered = [];
          return session;
        },
        (err: unknown) => {
          if (turn === this.turn) {
            this.deps.sendJson({
              type: 'error',
              message: err instanceof Error ? err.message : 'the listener did not start',
            });
          }
          return null;
        },
      );
    this.sttOpening = opening;
  }

  private async finishListening(turn: number): Promise<void> {
    if (turn !== this.turn || this.finishing) return;
    this.finishing = true;
    const session = this.stt ?? (await this.sttOpening);
    if (turn !== this.turn) return;
    this.stt = null;
    this.sttOpening = null;
    // The flush: the last words arrive as a final turn before this resolves.
    await session?.close().catch(() => {});
    if (turn !== this.turn) return;
    const text = this.finals.join(' ').trim();
    this.deps.sendJson({ type: 'turn-end', text });
    await this.answerAndSay(text, turn);
  }

  /** A choice tapped on the page: answered as if it had been heard. */
  private say(text: string): void {
    if (this.deps.readOnly) return;
    this.stopSpeaking();
    this.dropListener();
    this.turn++;
    if (this.setup === 3) {
      this.heardText = '';
      this.saidText = '';
      this.replied = false;
      this.dropAudio = false;
      const g = this.gemini;
      if (g) g.sendText(text);
      else
        this.deps.sendJson({ type: 'error', message: 'Say it instead — Gemini is not connected.' });
      return;
    }
    this.deps.sendJson({ type: 'turn-end', text });
    void this.answerAndSay(text, this.turn);
  }

  private async answerAndSay(text: string, turn: number): Promise<void> {
    const answer = await this.deps.answerer.answer(text, this.actor, this.context);
    if (turn !== this.turn) return;
    this.deps.sendJson(replyMessage(answer));
    const voice = this.setup === 3 ? null : this.deps.engines.voices[this.setup];
    if (!answer.spoken || !voice) return;
    await this.speak(voice, answer.spoken, turn);
  }

  private async speak(voice: SpokenVoice, text: string, turn: number): Promise<void> {
    const ctl = new AbortController();
    this.speaking = ctl;
    let started = false;
    try {
      await voice.speak(
        text,
        (pcm) => {
          if (ctl.signal.aborted || turn !== this.turn) return;
          if (!started) {
            started = true;
            this.deps.sendJson({ type: 'audio-start', sampleRate: SPOKEN_OUTPUT_RATE });
          }
          this.deps.sendAudio(pcm);
        },
        ctl.signal,
      );
    } catch (err) {
      if (!ctl.signal.aborted) {
        this.deps.sendJson({
          type: 'error',
          message: err instanceof Error ? err.message : 'the voice failed',
        });
      }
    } finally {
      if (started) this.deps.sendJson({ type: 'audio-end' });
      if (this.speaking === ctl) this.speaking = null;
    }
  }

  // ── Setup 3 ──────────────────────────────────────────────────────────────

  private startGemini(): void {
    const live = this.deps.engines.gemini;
    if (!live) return;
    const manual = this.mode === 'hold';
    this.heardText = '';
    this.saidText = '';
    this.replied = false;
    this.dropAudio = false;
    if (this.gemini && this.geminiManual === manual) {
      if (manual) this.gemini.activityStart();
      return;
    }
    this.gemini?.close();
    this.gemini = null;
    this.geminiManual = manual;
    // Audio said while the session connects is held and sent once it is up,
    // after the turn's start, as setups 1 and 2 hold theirs.
    const mine: { session: GeminiLiveSession | null } = { session: null };
    const opening = live
      .open({
        manual,
        events: {
          onInputText: (t) => {
            this.heardText += t;
            this.deps.sendJson({ type: 'heard', text: this.heardText.trim() });
          },
          onOutputText: (t) => {
            this.saidText += t;
          },
          onToolCall: (id, request) => void this.answerGemini(id, request),
          onAudio: (pcm) => {
            if (this.dropAudio) return;
            if (!this.audioOpen) {
              this.audioOpen = true;
              this.deps.sendJson({ type: 'audio-start', sampleRate: SPOKEN_OUTPUT_RATE });
            }
            this.deps.sendAudio(pcm);
          },
          onTurnComplete: () => this.geminiTurnDone(),
          onInterrupted: () => {
            if (this.audioOpen) this.deps.sendJson({ type: 'audio-end' });
            this.audioOpen = false;
          },
          onError: (message) => this.deps.sendJson({ type: 'error', message }),
          onClose: () => {
            if (this.gemini === mine.session) this.gemini = null;
          },
        },
      })
      .then(
        (s) => {
          mine.session = s;
          this.gemini = s;
          this.geminiOpening = null;
          if (manual) s.activityStart();
          for (const pcm of this.buffered) s.sendAudio(pcm);
          this.buffered = [];
          return s;
        },
        (err: unknown) => {
          this.geminiOpening = null;
          this.buffered = [];
          this.deps.sendJson({
            type: 'error',
            message: err instanceof Error ? err.message : 'Gemini did not start',
          });
          return null;
        },
      );
    this.geminiOpening = opening;
  }

  private async answerGemini(id: string, request: string): Promise<void> {
    const turn = this.turn;
    const text = this.heardText.trim() || request;
    this.deps.sendJson({ type: 'turn-end', text });
    const answer = await this.deps.answerer.answer(request || text, this.actor, this.context);
    if (turn !== this.turn) return;
    this.replied = true;
    this.deps.sendJson(replyMessage(answer));
    const session = this.gemini ?? (await this.geminiOpening);
    session?.answerTool(id, { spoken: answer.spoken, asking: answer.asking });
  }

  private geminiTurnDone(): void {
    if (this.audioOpen) this.deps.sendJson({ type: 'audio-end' });
    this.audioOpen = false;
    const said = this.saidText.trim();
    if (!this.replied && said) {
      // The model answered without asking the board — say what it said, so
      // the panel never shows a voice with no words.
      this.deps.sendJson({
        type: 'reply',
        spoken: said,
        detail: [],
        asking: false,
        route: 'gemini',
      });
    }
    if (this.replied || said) {
      this.heardText = '';
      this.saidText = '';
      this.replied = false;
    }
  }
}
