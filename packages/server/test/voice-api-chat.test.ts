/**
 * One turn of the voice API against a fake agent and a hand-driven clock:
 * the interim line, the keepalive, the answer, the timeout line, and an
 * answer that lands after its turn closed being said on the next one.
 */
import { describe, expect, it } from 'bun:test';
import {
  type SendResult,
  type Timers,
  type VoiceAgents,
  VoiceChat,
  slowLine,
} from '../src/voice-api/chat.ts';
import {
  type ApiError,
  type ChatTurn,
  KEEPALIVE_MS,
  PLAIN_WAIT_MS,
  STREAM_WAIT_MS,
} from '../src/voice-api/protocol.ts';

/** Timers fired by `advance`, never by the wall clock. */
function fakeTimers() {
  let at = 1_000_000;
  let next = 0;
  const due = new Map<number, { at: number; every: number; fn: () => void }>();
  const timers: Timers = {
    now: () => at,
    set: (fn, ms) => {
      due.set(++next, { at: at + ms, every: 0, fn });
      return next;
    },
    clear: (h) => due.delete(h as number),
    every: (fn, ms) => {
      due.set(++next, { at: at + ms, every: ms, fn });
      return next;
    },
    stop: (h) => due.delete(h as number),
  };
  const advance = (ms: number) => {
    const end = at + ms;
    while (true) {
      const [id, t] =
        [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0] ??
        [];
      if (id === undefined || !t) break;
      at = t.at;
      if (t.every) t.at += t.every;
      else due.delete(id);
      t.fn();
    }
    at = end;
  };
  return { timers, advance, pending: () => due.size };
}

function fakeAgents(result: SendResult = { kind: 'sent', name: 'Riverbend Helper' }) {
  const replies: Array<(text: string) => void> = [];
  const agents: VoiceAgents = {
    list: () => [{ id: 'riverbend-helper', name: 'Riverbend Helper', description: '' }],
    send: (_turn, reply) => {
      replies.push(reply);
      return result;
    },
  };
  return { agents, replies };
}

const SPEAKER = { id: 'known-alice', name: 'Alice' };

function turn(over: Partial<ChatTurn> = {}): ChatTurn {
  return {
    model: 'riverbend-helper',
    text: 'how far is Saltmarsh',
    history: [],
    conversationId: 'c1',
    stream: true,
    ...over,
  };
}

/** Everything a streamed body has sent so far, without waiting for its end. */
function collect(res: Response) {
  const out = { text: '', done: false };
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  const pump = async () => {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      out.text += decoder.decode(value, { stream: true });
    }
    out.done = true;
  };
  void pump();
  return out;
}

/** The content deltas a stream said, joined. */
function said(stream: string): string {
  return stream
    .split('\n\n')
    .filter((b) => b.startsWith('data: {'))
    .map((b) => JSON.parse(b.slice(6)) as { choices: Array<{ delta: { content?: string } }> })
    .map((c) => c.choices[0]?.delta.content ?? '')
    .join('');
}

/** Let the stream's reader take what has been queued. */
const drain = () => new Promise((r) => queueMicrotask(() => r(null))).then(() => Bun.sleep(0));

function asResponse(r: Response | ApiError | Promise<Response>): Response {
  if (!(r instanceof Response)) throw new Error('expected a streamed Response');
  return r;
}

describe('VoiceChat', () => {
  it('streams the interim line, a keepalive while waiting, then the answer', async () => {
    const { timers, advance, pending } = fakeTimers();
    const { agents, replies } = fakeAgents();
    const chat = new VoiceChat(agents, timers);
    const stream = collect(asResponse(chat.turn(turn(), SPEAKER)));
    await drain();
    expect(said(stream.text)).toBe('Working on it.');
    advance(KEEPALIVE_MS);
    await drain();
    expect(stream.text).toContain(': keepalive');
    replies[0]?.('Twelve miles.');
    await drain();
    expect(stream.done).toBe(true);
    expect(said(stream.text)).toBe('Working on it. Twelve miles.');
    expect(stream.text.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(pending()).toBe(0);
  });

  it('closes a stream with the slow line at the bound, and says the late answer next turn', async () => {
    const { timers, advance } = fakeTimers();
    const { agents, replies } = fakeAgents();
    const chat = new VoiceChat(agents, timers);
    const first = collect(asResponse(chat.turn(turn(), SPEAKER)));
    advance(STREAM_WAIT_MS - 1);
    await drain();
    expect(first.done).toBe(false);
    advance(1);
    await drain();
    expect(first.done).toBe(true);
    expect(said(first.text)).toBe(`Working on it. ${slowLine('Riverbend Helper')}`);

    replies[0]?.('Twelve miles.');
    const second = collect(asResponse(chat.turn(turn({ text: 'and back' }), SPEAKER)));
    await drain();
    expect(said(second.text)).toBe(
      'Riverbend Helper answered your earlier question: Twelve miles. Working on it.',
    );
    // A different conversation does not hear it.
    const other = collect(asResponse(chat.turn(turn({ conversationId: 'c2' }), SPEAKER)));
    await drain();
    expect(said(other.text)).toBe('Working on it.');
  });

  it('keeps an answer for the next turn when the client hangs up', async () => {
    const { timers, pending } = fakeTimers();
    const { agents, replies } = fakeAgents();
    const chat = new VoiceChat(agents, timers);
    const res = asResponse(chat.turn(turn(), SPEAKER));
    await res.body?.cancel();
    expect(pending()).toBe(0);
    replies[0]?.('Twelve miles.');
    const next = collect(asResponse(chat.turn(turn({ text: 'and back' }), SPEAKER)));
    await drain();
    expect(said(next.text)).toContain('answered your earlier question: Twelve miles.');
  });

  it('waits for a whole answer when not streamed, up to its own bound', async () => {
    const { timers, advance } = fakeTimers();
    const { agents, replies } = fakeAgents();
    const chat = new VoiceChat(agents, timers);
    const answered = chat.turn(turn({ stream: false }), SPEAKER) as Promise<Response>;
    replies[0]?.('Twelve miles.');
    const body = (await (await answered).json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0]?.message.content).toBe('Twelve miles.');

    const slow = chat.turn(
      turn({ stream: false, conversationId: 'c3' }),
      SPEAKER,
    ) as Promise<Response>;
    advance(PLAIN_WAIT_MS);
    const late = (await (await slow).json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(late.choices[0]?.message.content).toBe(slowLine('Riverbend Helper'));
  });

  it('says at once when the agent is away or the turn could not be sent', async () => {
    const { timers, pending } = fakeTimers();
    for (const [result, line] of [
      [{ kind: 'queued', name: 'Saltmarsh Away' }, 'Saltmarsh Away is away.'],
      [{ kind: 'failed' }, 'I couldn’t pass that on.'],
    ] as const) {
      const chat = new VoiceChat(fakeAgents(result).agents, timers);
      const stream = collect(asResponse(chat.turn(turn(), SPEAKER)));
      await drain();
      expect(stream.done).toBe(true);
      expect(said(stream.text).startsWith(line)).toBe(true);
    }
    expect(pending()).toBe(0);
  });

  it('answers model_not_found for an agent nobody answers to', () => {
    const { timers } = fakeTimers();
    const chat = new VoiceChat(fakeAgents({ kind: 'unknown' }).agents, timers);
    const r = chat.turn(turn({ model: 'bob-elsewhere' }), SPEAKER) as ApiError;
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('model_not_found');
  });
});
