/**
 * One reply panel's socket: hear a question, answer it, say the answer.
 *
 * A turn starts with the page's `start` and the microphone's PCM behind it.
 *
 *  - Setups 1 and 2 hear with Soniox's real-time listener. In `hold` mode the
 *    question ends when the page sends `end`; in `tap` mode it ends at the
 *    listener's own end of speech, called at most 500 ms after the last word
 *    (`SPOKEN_TAP_TUNING`) so the speaker can tap once and walk away. On a
 *    doc on this board the end of speech must also hold as a pause
 *    (`pause-gate.ts`), because the planning voice asks its questions only
 *    there, so that path keeps the latest end of speech Soniox allows. The
 *    words go to the answerer (the board mic's router), and the spoken part goes to the
 *    setup's voice point by point (`speak-points.ts`), each point's note
 *    sent just before its audio: Soniox TTS for 1, ElevenLabs Flash for 2.
 *  - Setup 3 streams the same PCM to Gemini Live, which calls back into the
 *    same answerer through its `ask_board` tool and speaks the result. A
 *    tapped question is heard by Soniox too when this server has it: its
 *    words show as they are said, and its end of speech asks the board and
 *    ends Gemini's bracketed turn, so the tool call collects an answer
 *    already on its way.
 *  - Setup 4 streams it to an ElevenLabs agent, which takes the turns and
 *    calls back into the same answerer through this server's custom-LLM
 *    route (`agent-turns.ts`).
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
  spokenSetupKey,
} from '@claude-workspaces/core/spoken-reply';
import type { TranscriptionEngine, TranscriptionSession } from '../transcribe.ts';
import type { VoiceActor } from '../voice-action.ts';
import type { VoiceContext } from '../voice-prompt.ts';
import type { AgentCallbacks } from './agent-llm.ts';
import { type AgentTurns, agentTurnsFor } from './agent-turns.ts';
import { type SpokenAnswer, type SpokenAnswerer, replyMessage } from './answer.ts';
import type { ElevenLabsAgent } from './elevenlabs-agent.ts';
import { FillerCue } from './filler-cue.ts';
import type { GeminiLive, GeminiLiveSession } from './gemini-live.ts';
import { type GateTimers, PauseGate } from './pause-gate.ts';
import { speakPoints } from './speak-points.ts';
import type { SpokenTimings } from './timings.ts';
import type { SpokenVoice } from './tts.ts';

export const SPOKEN_INPUT_RATE = 16_000;

/** The listener's tuning for a board question: end of speech called as soon
 *  as Soniox allows, 500 ms after the last word at most (Bryan, 2 Oct: tap
 *  once, and the turn ends on its own about half a second after he stops).
 *  A three-second thinking pause now ends the question; that is the trade.
 *  Level 2 is already the adapter's default. */
export const SPOKEN_TAP_TUNING = { max_endpoint_delay_ms: 500 };
/** On a planning doc the pause gate decides, so the listener waits as long as
 *  Soniox allows and a dangling sentence is not split into two turns. */
export const SPOKEN_PLANNING_TUNING = { max_endpoint_delay_ms: 3000 };

/** Audio held while the listener connects: 20s of 50ms frames. */
const MAX_BUFFERED_FRAMES = 400;

export interface SpokenEngines {
  /** Setups 1 and 2's ears. */
  listener: TranscriptionEngine | null;
  voices: { 1: SpokenVoice | null; 2: SpokenVoice | null };
  gemini: GeminiLive | null;
  /** Setup 1's voice as MP3, for a meeting bot to play (`meeting-claude.ts`). */
  meetingVoice?: SpokenVoice | null;
  /** Setup 4: the agent, and the secret its custom-LLM calls must carry. */
  agent?: { live: ElevenLabsAgent; llmSecret: string } | null;
  /** Built but not run yet, and why — see `SpokenHeldSetups`. */
  held?: SpokenHeldSetups;
}

export function availableSetups(e: SpokenEngines): SpokenSetup[] {
  return SPOKEN_SETUPS.filter((s) =>
    s === 4
      ? Boolean(e.agent)
      : s === 3
        ? e.gemini !== null
        : e.listener !== null && e.voices[s] !== null,
  );
}

export interface SpokenSessionDeps {
  engines: SpokenEngines;
  answerer: SpokenAnswerer;
  timings: SpokenTimings;
  /** Setup 4's route registry; without one setup 4 cannot be answered. */
  agentCallbacks?: AgentCallbacks;
  /** The identity the upgrade proved; the page's claim is used without one. */
  provenActor: VoiceActor | null;
  readOnly: boolean;
  parseContext(raw: unknown): VoiceContext | undefined;
  sendJson(msg: SpokenServerMessage): void;
  sendAudio(pcm: Uint8Array): void;
  /** The pause gate's clock; a test passes a fake one. */
  timers?: GateTimers;
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
  /** Audio held while the listener connects, apart from Gemini's own. */
  private sttBuffered: Uint8Array[] = [];
  private finals: string[] = [];
  private finishing = false;
  /** A planning doc's turn ends at a confirmed pause (`pause-gate.ts`). */
  private pause: PauseGate | null = null;
  private speaking: AbortController | null = null;
  /** The latest turn's slow-answer cue (`filler-cue.ts`), kept for its timing row. */
  private cue: FillerCue | null = null;

  // Setup 3: one Gemini session per socket, reopened only if the mode changes.
  private gemini: GeminiLiveSession | null = null;
  private geminiManual = false;
  private geminiOpening: Promise<GeminiLiveSession | null> | null = null;
  private heardText = '';
  private saidText = '';
  private replied = false;
  private audioOpen = false;
  private dropAudio = false;
  /** A tapped setup-3 question heard by Soniox too: its words show as they
   *  are said, and its end of speech sends the question to the board at once
   *  and ends Gemini's bracketed turn (`askEarly`). Gemini's own ears were
   *  measured on staging at about 1.1s from the last word to its tool call,
   *  with no words shown until then. */
  private geminiEars = false;
  private early: {
    turn: number;
    cue: FillerCue | null;
    answer: Promise<SpokenAnswer>;
  } | null = null;

  // Setup 4: its conversation opens at the first setup-4 start.
  private agentTurns: AgentTurns | null;

  constructor(private readonly deps: SpokenSessionDeps) {
    // Read at call time: the speaker and context of the latest start.
    this.agentTurns = agentTurnsFor(deps, (t) => {
      deps.sendJson({ type: 'working' });
      return deps.answerer.answer(t, this.actor, this.context);
    });
  }

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
      case 'decided':
        this.sayAside(this.deps.answerer.decided(msg.id, msg.ok));
        return;
      case 'timing':
        this.deps.timings.record({
          setup: this.setup,
          delayMs: msg.delayMs,
          ...(msg.endpointMs !== undefined ? { endpointMs: msg.endpointMs } : {}),
          ...(msg.replyMs !== undefined ? { replyMs: msg.replyMs } : {}),
          ...(msg.audioMs !== undefined ? { audioMs: msg.audioMs } : {}),
          ...(msg.noteLeadMs !== undefined ? { noteLeadMs: msg.noteLeadMs } : {}),
          ...(this.cue?.playedMs ? { cueMs: this.cue.playedMs } : {}),
          at: Date.now(),
        });
        this.deps.sendJson({ type: 'timings', summary: this.deps.timings.summary() });
        return;
    }
  }

  onAudio(pcm: Uint8Array): void {
    if (this.setup === 4) {
      this.agentTurns?.audio(pcm);
      return;
    }
    if (this.setup === 3) {
      if (this.gemini) this.gemini.sendAudio(pcm);
      else if (this.geminiOpening && this.buffered.length < MAX_BUFFERED_FRAMES) {
        this.buffered.push(pcm.slice());
      }
      if (!this.geminiEars) return;
    }
    if (this.stt) this.stt.send(pcm);
    else if (this.sttOpening && this.sttBuffered.length < MAX_BUFFERED_FRAMES) {
      this.sttBuffered.push(pcm.slice());
    }
  }

  close(): void {
    this.turn++;
    this.stopSpeaking();
    this.dropListener();
    this.deps.answerer.close();
    this.gemini?.close();
    this.gemini = null;
    this.agentTurns?.close();
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
          this.deps.engines.held?.[spokenSetupKey(msg.setup)] ??
          `Setup ${msg.setup} is not set up on this server.`,
      });
      return;
    }
    this.stopSpeaking();
    this.cue = null;
    this.dropListener();
    this.turn++;
    this.setup = msg.setup;
    this.mode = msg.mode;
    this.context = this.deps.parseContext(msg.context);
    this.actor = this.deps.provenActor ?? msg.author ?? NOBODY;
    if (msg.setup === 4) this.agentTurns?.start();
    else if (msg.setup === 3) this.startGemini();
    else this.startListening();
  }

  private end(): void {
    if (this.setup === 4) {
      this.agentTurns?.end();
      return;
    }
    if (this.setup === 3) {
      if (this.geminiEars) return void this.finishListening(this.turn);
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
    this.cue?.cancel();
    this.speaking?.abort();
    this.speaking = null;
    if (this.setup === 4) this.agentTurns?.stop();
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
    this.sttBuffered = [];
    this.finals = [];
    this.finishing = false;
    this.pause?.cancel();
    this.pause = null;
    void s?.close().catch(() => {});
  }

  private startListening(): void {
    const listener = this.deps.engines.listener;
    if (!listener) return;
    const turn = this.turn;
    if (this.mode === 'tap' && this.deps.answerer.converses(this.context)) {
      this.pause = new PauseGate(() => void this.finishListening(turn), this.deps.timers);
    }
    const opening = listener
      .open({
        sampleRate: SPOKEN_INPUT_RATE,
        detectSpeakers: false,
        tuning: this.pause ? SPOKEN_PLANNING_TUNING : SPOKEN_TAP_TUNING,
        onTurn: (t) => {
          if (turn !== this.turn) return;
          if (t.final) this.finals.push(t.text);
          const text = [...this.finals, ...(t.final ? [] : [t.text])].join(' ').trim();
          if (text) this.deps.sendJson({ type: 'heard', text });
          if (this.pause) this.pause.heard(text, t.final);
          else if (t.final && this.mode === 'tap') void this.finishListening(turn, true);
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
          for (const pcm of this.sttBuffered) session.send(pcm);
          this.sttBuffered = [];
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

  /** `endpointed`: the listener's end of speech already finalized every word,
   *  so the question goes to the answerer now and the socket closes behind
   *  it — the flush is a round trip to Soniox that would only add delay. */
  private async finishListening(turn: number, endpointed = false): Promise<void> {
    if (turn !== this.turn || this.finishing) return;
    this.finishing = true;
    const session = endpointed ? this.stt : (this.stt ?? (await this.sttOpening));
    if (turn !== this.turn) return;
    this.stt = null;
    this.sttOpening = null;
    // The flush: the last words arrive as a final turn before this resolves.
    if (endpointed) void session?.close().catch(() => {});
    else await session?.close().catch(() => {});
    if (turn !== this.turn) return;
    const text = this.finals.join(' ').trim();
    this.deps.sendJson({ type: 'turn-end', text });
    if (this.setup === 3) this.askEarly(text, turn);
    else await this.answerAndSay(text, turn);
  }

  /** A choice tapped on the page: answered as if it had been heard. */
  private say(text: string): void {
    if (this.deps.readOnly) return;
    this.stopSpeaking();
    this.cue = null;
    this.dropListener();
    this.turn++;
    if (this.setup === 4) {
      this.agentTurns?.say(text);
      return;
    }
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
    const voice =
      this.setup === 1 || this.setup === 2 ? this.deps.engines.voices[this.setup] : null;
    const cue = this.armCue(voice, text, turn);
    if (text) this.deps.sendJson({ type: 'working' });
    const answer = await this.deps.answerer.answer(text, this.actor, this.context);
    if (turn !== this.turn) return;
    this.deps.sendJson(replyMessage(answer));
    const opened = (await cue?.ready()) === true;
    if (turn !== this.turn) return;
    if (!answer.spoken || !voice) {
      if (opened) this.deps.sendJson({ type: 'audio-end' });
      return;
    }
    await this.speak(voice, answer, turn, opened);
  }

  /** Arm the slow-answer cue for the question just heard, in `voice`. */
  private armCue(voice: SpokenVoice | null, heard: string, turn: number): FillerCue | null {
    this.cue?.cancel();
    this.cue = voice
      ? new FillerCue({
          voice,
          heard,
          live: () => turn === this.turn && !(this.setup === 3 && this.dropAudio),
          sendJson: this.deps.sendJson,
          sendAudio: this.deps.sendAudio,
          ...(this.deps.timers ? { timers: this.deps.timers } : {}),
        })
      : null;
    return this.cue;
  }

  /** A failed review write, said unasked — only written while the speaker talks. */
  private sayAside(answer: SpokenAnswer | null): void {
    if (!answer) return;
    const voice =
      this.setup === 1 || this.setup === 2 ? this.deps.engines.voices[this.setup] : null;
    const say = voice && answer.spoken && this.stt === null && this.sttOpening === null;
    if (say) this.stopSpeaking();
    this.deps.sendJson(replyMessage(answer));
    if (say) void this.speak(voice, answer, ++this.turn);
  }

  private async speak(
    voice: SpokenVoice,
    answer: SpokenAnswer,
    turn: number,
    opened = false,
  ): Promise<void> {
    const ctl = new AbortController();
    this.speaking = ctl;
    try {
      await speakPoints({
        voice,
        points: answer.points,
        signal: ctl.signal,
        live: () => turn === this.turn,
        sendJson: this.deps.sendJson,
        sendAudio: this.deps.sendAudio,
        opened,
      });
    } catch (err) {
      if (!ctl.signal.aborted) {
        this.deps.sendJson({
          type: 'error',
          message: err instanceof Error ? err.message : 'the voice failed',
        });
      }
    } finally {
      if (this.speaking === ctl) this.speaking = null;
    }
  }

  // ── Setup 3 ──────────────────────────────────────────────────────────────

  private startGemini(): void {
    const live = this.deps.engines.gemini;
    if (!live) return;
    // With Soniox beside it, Soniox's end of speech ends Gemini's turn too, so
    // Gemini runs bracketed, as for a held question.
    this.geminiEars = this.mode === 'tap' && this.deps.engines.listener !== null;
    const manual = this.mode === 'hold' || this.geminiEars;
    this.heardText = '';
    this.saidText = '';
    this.replied = false;
    this.dropAudio = false;
    this.early = null;
    if (this.geminiEars) this.startListening();
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
            if (!this.geminiEars)
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

  /** Setup 3's question, heard by Soniox: asked of the board now, and
   *  collected by the tool call Gemini makes for the same words. */
  private askEarly(text: string, turn: number): void {
    // Gemini's turn is bracketed, and this is its end.
    void (this.gemini ? Promise.resolve(this.gemini) : this.geminiOpening)?.then((g) => {
      if (turn === this.turn) g?.activityEnd();
    });
    if (!text) return;
    this.early = {
      turn,
      cue: this.armCue(this.cueVoice(), text, turn),
      answer: this.deps.answerer.answer(text, this.actor, this.context),
    };
    this.deps.sendJson({ type: 'working' });
  }

  /** Gemini says nothing while the board answers, so the cue is said in
   *  this server's own voice. */
  private cueVoice(): SpokenVoice | null {
    return this.deps.engines.voices[1] ?? this.deps.engines.voices[2];
  }

  private async answerGemini(id: string, request: string): Promise<void> {
    const turn = this.turn;
    const early = this.early?.turn === turn ? this.early : null;
    this.early = null;
    let cue = early?.cue ?? null;
    let pending = early?.answer;
    if (!pending) {
      // Gemini called the question over first: Soniox's turn is moot.
      if (this.geminiEars) this.dropListener();
      const text = this.heardText.trim() || request;
      this.deps.sendJson({ type: 'turn-end', text });
      const asked = this.deps.answerer.verbatim ? text : request || text;
      cue = this.armCue(this.cueVoice(), text, turn);
      this.deps.sendJson({ type: 'working' });
      pending = this.deps.answerer.answer(asked, this.actor, this.context);
    }
    const answer = await pending;
    if (turn !== this.turn) return;
    this.replied = true;
    this.deps.sendJson(replyMessage(answer));
    // The model speaks the answer as one stream, so there is no point to
    // align a note with: every note goes before the tool result that starts
    // the voice, which keeps each one ahead of its point.
    answer.points.forEach((p, i) => {
      if (p.note) this.deps.sendJson({ type: 'note', point: i, text: p.note });
    });
    if (await cue?.ready()) this.audioOpen = true;
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
        points: [{ say: said }],
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
