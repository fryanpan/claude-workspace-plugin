/**
 * Setup 4: an ElevenLabs agent hears the question, decides where the turn
 * ends, and speaks the answer. The words come from this server: the agent is
 * configured with a CUSTOM LLM whose URL is this server's
 * `/voice-agent/v1/chat/completions`, so ElevenLabs calls back here for every
 * reply (`agent-llm.ts`). What setup 4 changes is the ears, the turn-taking
 * and the voice, not the answer.
 *
 * The browser never talks to ElevenLabs. This server holds the socket and the
 * key, as it does for Gemini in setup 3, and the page streams its microphone
 * here exactly as it does for every other setup.
 *
 * PROTOCOL (Agents Platform WebSocket reference, read 2026-10-01):
 *  - `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=<id>`, with the
 *    key in the `xi-api-key` header — never in the URL, which a proxy logs.
 *  - first frame up: `conversation_initiation_client_data`, carrying
 *    `custom_llm_extra_body`. ElevenLabs hands that object to the custom LLM
 *    as `elevenlabs_extra_body`, which is how the route finds this socket.
 *  - the server answers `conversation_initiation_metadata`, naming the audio
 *    formats. Input must be `pcm_16000` (what the page captures); output is
 *    any `pcm_<rate>`, and the page plays it at that rate.
 *  - audio up: `{user_audio_chunk: <base64 PCM16>}`; text up:
 *    `{type: 'user_message', text}`.
 *  - down: `audio`, `user_transcript` (their turn-taking calling the question
 *    over), `agent_response`, `interruption`, and `ping`, which must be
 *    answered `{type: 'pong', event_id}` or the conversation is dropped.
 */

const CONVERSATION_URL = 'wss://api.elevenlabs.io/v1/convai/conversation';
const CONNECT_TIMEOUT_MS = 10_000;

/** The field of `custom_llm_extra_body` the route reads. */
export const AGENT_SESSION_FIELD = 'cw_session';

export interface AgentSocket {
  send(data: string): void;
  close(): void;
}

export interface AgentSocketArgs {
  url: string;
  headers: Record<string, string>;
  onOpen: () => void;
  onMessage: (text: string) => void;
  onError: (message: string) => void;
  onClose: (reason: string) => void;
}

export type AgentSocketFactory = (args: AgentSocketArgs) => AgentSocket;

export interface AgentEvents {
  /** ElevenLabs decided the question is over, and heard this. */
  onUserTranscript(text: string): void;
  onAgentResponse(text: string): void;
  onAudio(pcm: Uint8Array): void;
  onInterrupted(): void;
  onError(message: string): void;
  onClose(): void;
}

export interface AgentSession {
  /** The rate the agent's audio arrives at, from its own metadata. */
  readonly outputRate: number;
  sendAudio(pcm16k: Uint8Array): void;
  /** A choice tapped on the page, sent as if it had been said. */
  sendText(text: string): void;
  close(): void;
}

export interface ElevenLabsAgent {
  readonly name: string;
  /** `callbackToken` rides in `custom_llm_extra_body` for the route. */
  open(opts: { callbackToken: string; events: AgentEvents }): Promise<AgentSession>;
}

/** The first frame, exported so a test holds its shape still. */
export function agentInitiation(callbackToken: string): Record<string, unknown> {
  return {
    type: 'conversation_initiation_client_data',
    custom_llm_extra_body: { [AGENT_SESSION_FIELD]: callbackToken },
  };
}

/** `pcm_24000` → 24000; anything else (μ-law, MP3, garbage) → null. */
export function pcmRate(format: unknown): number | null {
  if (typeof format !== 'string') return null;
  const m = format.match(/^pcm_(\d{4,5})$/);
  const rate = m ? Number(m[1]) : Number.NaN;
  return rate >= 8000 && rate <= 48000 ? rate : null;
}

function defaultSocket(args: AgentSocketArgs): AgentSocket {
  // Bun's WebSocket takes headers; the DOM type does not know that.
  const ws = new WebSocket(args.url, { headers: args.headers } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  const decoder = new TextDecoder();
  ws.addEventListener('open', () => args.onOpen());
  ws.addEventListener('message', (ev: MessageEvent) => {
    const data = ev.data as unknown;
    if (typeof data === 'string') args.onMessage(data);
    else if (data instanceof ArrayBuffer) args.onMessage(decoder.decode(data));
  });
  ws.addEventListener('error', () => args.onError('websocket error'));
  // The close reason is ElevenLabs' own sentence; the key rode in a header
  // and is never part of it.
  ws.addEventListener('close', (ev: CloseEvent) => args.onClose(ev.reason || `code ${ev.code}`));
  return { send: (d) => ws.send(d), close: () => ws.close() };
}

export function createElevenLabsAgent(opts: {
  apiKey: string;
  agentId: string;
  socketFactory?: AgentSocketFactory;
  connectTimeoutMs?: number;
}): ElevenLabsAgent {
  const makeSocket = opts.socketFactory ?? defaultSocket;
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  return {
    name: 'elevenlabs-agent',
    open({ callbackToken, events }) {
      return new Promise<AgentSession>((resolve, reject) => {
        let ready = false;
        let closed = false;
        const timer = setTimeout(() => {
          if (ready) return;
          closed = true;
          socket.close();
          reject(new Error('elevenlabs agent: no metadata within the connect timeout'));
        }, connectTimeoutMs);
        timer.unref?.();
        const send = (msg: unknown): void => {
          if (!closed) socket.send(JSON.stringify(msg));
        };
        const fail = (message: string): void => {
          closed = true;
          clearTimeout(timer);
          socket.close();
          reject(new Error(message));
        };
        const session = (outputRate: number): AgentSession => ({
          outputRate,
          sendAudio: (pcm) => send({ user_audio_chunk: Buffer.from(pcm).toString('base64') }),
          sendText: (text) => send({ type: 'user_message', text }),
          close: () => {
            if (closed) return;
            closed = true;
            socket.close();
          },
        });
        const socket = makeSocket({
          url: `${CONVERSATION_URL}?agent_id=${encodeURIComponent(opts.agentId)}`,
          headers: { 'xi-api-key': opts.apiKey },
          onOpen: () => socket.send(JSON.stringify(agentInitiation(callbackToken))),
          onMessage: (text) => {
            let m: Record<string, unknown>;
            try {
              m = JSON.parse(text) as Record<string, unknown>;
            } catch {
              return;
            }
            if (m.type === 'ping') {
              const ping = m.ping_event as { event_id?: unknown } | undefined;
              send({ type: 'pong', event_id: ping?.event_id });
              return;
            }
            if (m.type === 'conversation_initiation_metadata' && !ready) {
              const meta = (m.conversation_initiation_metadata_event ?? {}) as Record<
                string,
                unknown
              >;
              if (meta.user_input_audio_format !== 'pcm_16000') {
                fail("elevenlabs agent: set the agent's input audio format to PCM 16000 Hz");
                return;
              }
              const rate = pcmRate(meta.agent_output_audio_format);
              if (rate === null) {
                fail("elevenlabs agent: set the agent's output audio format to PCM");
                return;
              }
              ready = true;
              clearTimeout(timer);
              resolve(session(rate));
              return;
            }
            if (ready) readServerMessage(m, events);
          },
          onError: (msg) => {
            if (!ready) {
              clearTimeout(timer);
              reject(new Error(`elevenlabs agent: ${msg}`));
            } else events.onError(`elevenlabs agent: ${msg}`);
          },
          onClose: (reason) => {
            const wasClosed = closed;
            closed = true;
            if (!ready) {
              clearTimeout(timer);
              reject(new Error(`elevenlabs agent: closed before it started (${reason})`));
              return;
            }
            if (!wasClosed) events.onError(`elevenlabs agent: closed (${reason})`);
            events.onClose();
          },
        });
      });
    },
  };
}

function readServerMessage(m: Record<string, unknown>, events: AgentEvents): void {
  switch (m.type) {
    case 'audio': {
      const data = (m.audio_event as { audio_base_64?: unknown } | undefined)?.audio_base_64;
      if (typeof data === 'string' && data) {
        events.onAudio(new Uint8Array(Buffer.from(data, 'base64')));
      }
      return;
    }
    case 'user_transcript': {
      const t = (m.user_transcription_event as { user_transcript?: unknown } | undefined)
        ?.user_transcript;
      if (typeof t === 'string') events.onUserTranscript(t);
      return;
    }
    case 'agent_response': {
      const t = (m.agent_response_event as { agent_response?: unknown } | undefined)
        ?.agent_response;
      if (typeof t === 'string' && t) events.onAgentResponse(t);
      return;
    }
    case 'interruption':
      events.onInterrupted();
      return;
  }
}
