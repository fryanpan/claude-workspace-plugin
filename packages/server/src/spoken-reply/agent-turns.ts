/**
 * Setup 4 on one spoken socket: the page's frames in, an ElevenLabs agent
 * conversation out, and the agent's calls back for a reply answered by this
 * socket's own answerer.
 *
 * One conversation per socket, opened at the first setup-4 `start` and kept,
 * as setup 3 keeps its Gemini session. ElevenLabs decides where each question
 * ends — that is the turn-taking setup 4 is there to compare — so `tap` and
 * `hold` differ only in what the page does with the microphone. On a hold's
 * release the page stops sending, and this sends a short run of silence so
 * the agent's end-of-turn detection has a pause to find.
 *
 * What the page sees is the same frame sequence every setup sends: `heard`
 * and `turn-end` when the agent calls the question over, `reply` when the
 * route answers, then `audio-start` … `audio-end` around the voice. The agent
 * marks no end to its audio, so `audio-end` is sent once no audio has arrived
 * for `audioQuietMs`, or at once on an interruption or a `stop`.
 */
import type { SpokenServerMessage } from '@claude-workspaces/core/spoken-reply';
import type { AgentCallbacks } from './agent-llm.ts';
import { type SpokenAnswer, replyMessage } from './answer.ts';
import type { AgentSession, ElevenLabsAgent } from './elevenlabs-agent.ts';

/** Audio held while the conversation connects: 20s of 50ms frames. */
const MAX_BUFFERED_FRAMES = 400;
/** No audio for this long ends the reply's voice on the page. */
export const AGENT_AUDIO_QUIET_MS = 700;
/** Silence sent on a hold's release: 1.5s of 16 kHz PCM16, in 100ms frames. */
const RELEASE_SILENCE_FRAMES = 15;
const SILENCE_FRAME = new Uint8Array(3200);

export interface AgentTurnsDeps {
  agent: ElevenLabsAgent;
  callbacks: AgentCallbacks;
  /** The socket's answerer, with the speaker and context of the last start. */
  answer(text: string): Promise<SpokenAnswer>;
  sendJson(msg: SpokenServerMessage): void;
  sendAudio(pcm: Uint8Array): void;
  audioQuietMs?: number;
}

/** Setup 4's driver for one socket, or null when setup 4 is not configured. */
export function agentTurnsFor(
  deps: {
    engines: { agent?: { live: ElevenLabsAgent } | null };
    agentCallbacks?: AgentCallbacks;
    sendJson(msg: SpokenServerMessage): void;
    sendAudio(pcm: Uint8Array): void;
  },
  answer: (text: string) => Promise<SpokenAnswer>,
): AgentTurns | null {
  const agent = deps.engines.agent;
  if (!agent || !deps.agentCallbacks) return null;
  return new AgentTurns({
    agent: agent.live,
    callbacks: deps.agentCallbacks,
    answer,
    sendJson: deps.sendJson,
    sendAudio: deps.sendAudio,
  });
}

export class AgentTurns {
  private session: AgentSession | null = null;
  private opening: Promise<AgentSession | null> | null = null;
  private token: string | null = null;
  private buffered: Uint8Array[] = [];
  private heardText = '';
  private turnEnded = false;
  private replied = false;
  private audioOpen = false;
  private dropAudio = false;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly deps: AgentTurnsDeps) {}

  /** The conversation is up. */
  get connected(): boolean {
    return this.session !== null;
  }

  /** A new question begins on the page. */
  start(): void {
    this.resetTurn();
    if (!this.session && !this.opening) this.open();
  }

  audio(pcm: Uint8Array): void {
    if (this.session) this.session.sendAudio(pcm);
    else if (this.opening && this.buffered.length < MAX_BUFFERED_FRAMES) {
      this.buffered.push(pcm.slice());
    }
  }

  /** A hold released: the page has stopped sending; let the agent hear it. */
  end(): void {
    for (let i = 0; i < RELEASE_SILENCE_FRAMES; i++) this.audio(SILENCE_FRAME);
  }

  /** A choice tapped instead of said. */
  say(text: string): void {
    this.resetTurn();
    this.turnEnded = true;
    const s = this.session;
    if (!s) {
      this.deps.sendJson({
        type: 'error',
        message: 'Say it instead — the ElevenLabs agent is not connected.',
      });
      return;
    }
    this.deps.sendJson({ type: 'turn-end', text });
    s.sendText(text);
  }

  /** The speaker cut in: nothing more of this reply reaches the page. */
  stop(): void {
    this.dropAudio = true;
    this.endAudio();
  }

  close(): void {
    this.closed = true;
    if (this.token) this.deps.callbacks.revoke(this.token);
    this.token = null;
    this.clearQuiet();
    this.session?.close();
    this.session = null;
    this.buffered = [];
  }

  private resetTurn(): void {
    this.endAudio();
    this.heardText = '';
    this.turnEnded = false;
    this.replied = false;
    this.dropAudio = false;
  }

  private open(): void {
    const token = this.deps.callbacks.mint((q) => this.onLlm(q));
    this.token = token;
    this.opening = this.deps.agent
      .open({
        callbackToken: token,
        events: {
          onUserTranscript: (t) => this.onTranscript(t),
          onAgentResponse: (t) => this.onAgentResponse(t),
          onAudio: (pcm) => this.onAudio(pcm),
          onInterrupted: () => this.endAudio(),
          onError: (message) => this.deps.sendJson({ type: 'error', message }),
          onClose: () => this.onClosed(),
        },
      })
      .then(
        (s) => {
          this.opening = null;
          if (this.closed) {
            s.close();
            return null;
          }
          this.session = s;
          for (const pcm of this.buffered) s.sendAudio(pcm);
          this.buffered = [];
          return s;
        },
        (err: unknown) => {
          this.opening = null;
          this.buffered = [];
          this.forgetToken();
          if (!this.closed) {
            this.deps.sendJson({
              type: 'error',
              message: err instanceof Error ? err.message : 'the ElevenLabs agent did not start',
            });
          }
          return null;
        },
      );
  }

  /** The conversation ended on ElevenLabs' side; the next start reopens. */
  private onClosed(): void {
    this.session = null;
    this.endAudio();
    this.forgetToken();
  }

  private forgetToken(): void {
    if (this.token) this.deps.callbacks.revoke(this.token);
    this.token = null;
  }

  private callOver(text: string): void {
    if (this.turnEnded) return;
    this.turnEnded = true;
    this.deps.sendJson({ type: 'turn-end', text });
  }

  private onTranscript(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.heardText = t;
    this.deps.sendJson({ type: 'heard', text: t });
    this.callOver(t);
  }

  /** The route's call: answer it as every other setup answers. */
  private async onLlm(question: string): Promise<string> {
    this.callOver(this.heardText || question);
    const answer = await this.deps.answer(question);
    this.replied = true;
    this.deps.sendJson(replyMessage(answer));
    return answer.spoken;
  }

  private onAgentResponse(text: string): void {
    if (this.replied) return;
    // The agent spoke without asking this server — its first message, or a
    // fallback of its own. Say what it said, so the panel never shows a voice
    // with no words.
    this.replied = true;
    this.deps.sendJson({ type: 'reply', spoken: text, detail: [], asking: false, route: 'agent' });
  }

  private onAudio(pcm: Uint8Array): void {
    if (this.dropAudio || !this.session) return;
    if (!this.audioOpen) {
      this.audioOpen = true;
      this.deps.sendJson({ type: 'audio-start', sampleRate: this.session.outputRate });
    }
    this.deps.sendAudio(pcm);
    this.clearQuiet();
    this.quiet = setTimeout(() => {
      this.quiet = null;
      this.endAudio();
    }, this.deps.audioQuietMs ?? AGENT_AUDIO_QUIET_MS);
    this.quiet.unref?.();
  }

  private endAudio(): void {
    this.clearQuiet();
    if (this.audioOpen) this.deps.sendJson({ type: 'audio-end' });
    this.audioOpen = false;
  }

  private clearQuiet(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
  }
}
