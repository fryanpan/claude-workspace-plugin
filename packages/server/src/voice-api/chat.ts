/**
 * One turn of the voice conversation API, from a parsed request to the
 * response: said at once when the agent is away, streamed with an interim
 * line while it works, and closed with a spoken line when it takes too long.
 *
 * An answer that lands after its turn was closed is not lost: it is kept for
 * the conversation and said first on that conversation's next turn.
 *
 * What an agent is, and how a turn reaches one, is `VoiceAgents`, which the
 * server implements over its boards (`backend.ts`). Timers are injected, so
 * a test drives the waits without sleeping.
 */
import {
  type ApiError,
  type ChatTurn,
  INTERIM_LINE,
  KEEPALIVE,
  KEEPALIVE_MS,
  type ModelEntry,
  PLAIN_WAIT_MS,
  STREAM_DONE,
  STREAM_WAIT_MS,
  apiError,
  chunk,
  completion,
} from './protocol.ts';

export interface Speaker {
  id: string;
  name: string;
}

export type SendResult =
  | { kind: 'sent' | 'queued'; name: string }
  | { kind: 'unknown' }
  | { kind: 'failed' };

/** The server side of the protocol: who can be talked to, and how a turn
 *  reaches one. `reply` is called at most once, whenever the answer lands. */
export interface VoiceAgents {
  list(): ModelEntry[];
  send(
    turn: Pick<ChatTurn, 'text' | 'history' | 'conversationId'> & {
      agentId: string;
      speaker: Speaker;
    },
    reply: (text: string) => void,
  ): SendResult;
}

export interface Timers {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  every(fn: () => void, ms: number): unknown;
  stop(handle: unknown): void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  every: (fn, ms) => setInterval(fn, ms),
  stop: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export function awayLine(name: string): string {
  return `${name} is away. I’ll pass it on when they’re back.`;
}

export function slowLine(name: string): string {
  return `${name} is still working on it. Ask me again in a bit and I’ll tell you what they said.`;
}

export const FAILED_LINE = 'I couldn’t pass that on. Say it again.';

/** Late answers kept per conversation, and conversations kept. */
const LATE_PER_CONVERSATION = 5;
const LATE_CONVERSATIONS = 200;

export class VoiceChat {
  private late = new Map<string, string[]>();
  private seq = 0;

  constructor(
    private readonly agents: VoiceAgents,
    private readonly timers: Timers = realTimers,
  ) {}

  models(): ModelEntry[] {
    return this.agents.list();
  }

  private keepLate(conversationId: string, text: string): void {
    const list = this.late.get(conversationId) ?? [];
    list.push(text);
    this.late.delete(conversationId);
    this.late.set(conversationId, list.slice(-LATE_PER_CONVERSATION));
    while (this.late.size > LATE_CONVERSATIONS) {
      const oldest = this.late.keys().next().value;
      if (oldest === undefined) break;
      this.late.delete(oldest);
    }
  }

  private takeLate(conversationId: string): string {
    const list = this.late.get(conversationId);
    this.late.delete(conversationId);
    return list?.length ? `${list.join(' ')} ` : '';
  }

  /** Answer one turn. An `ApiError` for a model nobody answers to; a
   *  promise when the whole answer is waited for rather than streamed. */
  turn(t: ChatTurn, speaker: Speaker): Response | ApiError | Promise<Response> {
    const id = `chatcmpl-${this.timers.now().toString(36)}${(++this.seq).toString(36)}`;
    const created = Math.floor(this.timers.now() / 1000);
    let open = true;
    let onAnswer: ((text: string) => void) | null = null;
    const sent = this.agents.send(
      {
        agentId: t.model,
        text: t.text,
        history: t.history,
        conversationId: t.conversationId,
        speaker,
      },
      (text) => {
        if (open && onAnswer) onAnswer(text);
        else
          this.keepLate(
            t.conversationId,
            `${nameOf(sent)} answered your earlier question: ${text}`,
          );
      },
    );
    if (sent.kind === 'unknown') {
      open = false;
      return apiError(404, 'model_not_found', `No agent ${t.model} on your boards.`);
    }
    const before = this.takeLate(t.conversationId);
    const whole = (text: string) => this.whole(t, id, created, `${before}${text}`);
    if (sent.kind === 'failed') {
      open = false;
      return whole(FAILED_LINE);
    }
    if (sent.kind === 'queued') {
      open = false;
      return whole(awayLine(sent.name));
    }
    if (!t.stream) {
      return new Promise<string>((resolve) => {
        const timer = this.timers.set(() => {
          open = false;
          resolve(slowLine(sent.name));
        }, PLAIN_WAIT_MS);
        onAnswer = (text) => {
          open = false;
          this.timers.clear(timer);
          resolve(text);
        };
      }).then((text) => Response.json(completion(id, t.model, created, `${before}${text}`)));
    }
    const enc = new TextEncoder();
    let stop = () => {};
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        const write = (s: string) => c.enqueue(enc.encode(s));
        let ping: unknown = null;
        let timer: unknown = null;
        const finish = (text: string) => {
          if (!open) return;
          open = false;
          this.timers.stop(ping);
          this.timers.clear(timer);
          write(chunk(id, t.model, created, { content: ` ${text}` }));
          write(chunk(id, t.model, created, {}, 'stop'));
          write(STREAM_DONE);
          c.close();
        };
        write(
          chunk(id, t.model, created, { role: 'assistant', content: `${before}${INTERIM_LINE}` }),
        );
        ping = this.timers.every(() => {
          if (open) write(KEEPALIVE);
        }, KEEPALIVE_MS);
        timer = this.timers.set(() => finish(slowLine(sent.name)), STREAM_WAIT_MS);
        onAnswer = finish;
        stop = () => {
          open = false;
          this.timers.stop(ping);
          this.timers.clear(timer);
        };
      },
      // The client went: a later answer is kept for the next turn.
      cancel: () => stop(),
    });
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      },
    });
  }

  private whole(t: ChatTurn, id: string, created: number, text: string): Response {
    if (!t.stream) return Response.json(completion(id, t.model, created, text));
    const s =
      chunk(id, t.model, created, { role: 'assistant', content: text }) +
      chunk(id, t.model, created, {}, 'stop') +
      STREAM_DONE;
    return new Response(s, {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
    });
  }
}

function nameOf(r: SendResult): string {
  return r.kind === 'sent' || r.kind === 'queued' ? r.name : 'The agent';
}
