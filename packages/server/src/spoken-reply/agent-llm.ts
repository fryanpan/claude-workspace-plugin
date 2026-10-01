/**
 * The custom-LLM half of setup 4: what ElevenLabs sends when its agent wants
 * a reply, how that request is checked, and what goes back.
 *
 * ElevenLabs treats this server as an OpenAI-compatible model. Its agent is
 * configured with a server URL ending `/voice-agent/v1`, appends
 * `/chat/completions`, and POSTs the conversation so far, with the LLM secret
 * as `Authorization: Bearer` and the `custom_llm_extra_body` this server
 * opened the conversation with as `elevenlabs_extra_body` (custom-LLM guide,
 * read 2026-10-01). The answer is a streamed `chat.completion.chunk` sequence
 * ending `data: [DONE]`, or one `chat.completion` when `stream` is false.
 *
 * TWO CREDENTIALS, both required, and neither enough alone:
 *  - the LLM secret, the same for every conversation, compared in constant
 *    time. It proves the caller is the ElevenLabs account Bryan configured.
 *  - the callback token: 128 CSPRNG bits minted per spoken socket and
 *    forgotten when that socket closes (`AgentCallbacks`). It names WHICH
 *    socket's board and speaker the question is answered for, so the route
 *    never takes a workspace id, a person or a context from the body.
 *
 * The reply's words come from the socket's own `SpokenAnswerer` — the board
 * mic's router, the same as setups 1-3 — so a valid request can do exactly
 * what speaking into that socket could do, for as long as the socket is open.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AGENT_SESSION_FIELD } from './elevenlabs-agent.ts';

/** The one path the route answers. The agent's server URL is this minus
 *  `/chat/completions`. */
export const VOICE_AGENT_LLM_PATH = '/voice-agent/v1/chat/completions';

/** Larger than any conversation a board question builds; the history
 *  ElevenLabs re-sends grows by one short turn per question. */
export const AGENT_LLM_MAX_BODY_BYTES = 256 * 1024;
/** The longest question passed to the answerer, as the page's `say` caps. */
const MAX_QUESTION_CHARS = 2000;

const TOKEN_SHAPE = /^[0-9a-f]{32}$/;

/** The per-socket answerers the route reaches, keyed by callback token. */
export class AgentCallbacks {
  private readonly live = new Map<string, (question: string) => Promise<string>>();

  /** A fresh token for one socket's conversation. */
  mint(answer: (question: string) => Promise<string>): string {
    const token = randomBytes(16).toString('hex');
    this.live.set(token, answer);
    return token;
  }

  revoke(token: string): void {
    this.live.delete(token);
  }

  /** The socket's answer, or null when no open socket holds this token. */
  answer(token: string, question: string): Promise<string> | null {
    const cb = TOKEN_SHAPE.test(token) ? this.live.get(token) : undefined;
    return cb ? cb(question) : null;
  }

  get size(): number {
    return this.live.size;
  }
}

/**
 * Does the Authorization header carry exactly `Bearer <secret>`?
 *
 * Both sides are hashed first so the comparison is fixed-length: Node's
 * `timingSafeEqual` throws on a length mismatch, and returning early on one
 * would say how long the secret is.
 */
export function bearerMatches(header: string | null, secret: string): boolean {
  const m = header?.match(/^Bearer ([\x21-\x7e]{1,512})$/);
  const given = m?.[1];
  if (!given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

export interface AgentLlmRequest {
  token: string;
  question: string;
  stream: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) =>
      typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'text'
        ? String((p as { text?: unknown }).text ?? '')
        : '',
    )
    .join(' ');
}

/**
 * The body, checked. Null for anything that is not a chat-completions request
 * naming a well-formed callback token: bad JSON, no `messages` array, no user
 * message, a token of the wrong shape.
 *
 * The question is the LAST user message. ElevenLabs re-sends the whole
 * history and its own system prompt every time, and everything but the last
 * thing said is already in the answerer's state — or deliberately not, since
 * the router answers each question on its own.
 */
export function parseAgentLlmRequest(raw: string): AgentLlmRequest | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const extra = b.elevenlabs_extra_body;
  const token =
    typeof extra === 'object' && extra !== null
      ? (extra as Record<string, unknown>)[AGENT_SESSION_FIELD]
      : undefined;
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return null;
  if (!Array.isArray(b.messages) || b.messages.length > 500) return null;
  let question: string | null = null;
  for (const m of b.messages) {
    if (typeof m !== 'object' || m === null) return null;
    const msg = m as { role?: unknown; content?: unknown };
    if (msg.role === 'user') question = textOf(msg.content);
  }
  if (question === null) return null;
  return {
    token,
    question: question.trim().slice(0, MAX_QUESTION_CHARS),
    stream: b.stream === true,
  };
}

const MODEL = 'claude-workspaces';

/** The reply in the shape the request asked for. */
export function agentLlmResponse(spoken: string, stream: boolean, now = Date.now()): Response {
  const id = `chatcmpl-${randomBytes(8).toString('hex')}`;
  const created = Math.floor(now / 1000);
  if (!stream) {
    return Response.json({
      id,
      object: 'chat.completion',
      created,
      model: MODEL,
      choices: [
        { index: 0, message: { role: 'assistant', content: spoken }, finish_reason: 'stop' },
      ],
    });
  }
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const body =
    chunk({ role: 'assistant', content: spoken }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}
