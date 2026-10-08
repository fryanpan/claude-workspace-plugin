/**
 * The voice conversation API's wire format: the OpenAI chat format, text
 * only, so any OpenAI-compatible client can talk to an agent.
 *
 *   GET  /v1/models            one model per agent the caller may talk to
 *   POST /v1/chat/completions  one turn; `model` names the agent
 *
 * The client does speech-to-text and text-to-speech. Continuity is the
 * messages array the client already keeps, plus a conversation id: the
 * `x-conversation-id` header when the client sends one, else derived from the
 * caller's token, the model and the first user message. The full contract is
 * `docs/architecture/voice-conversation-api.md`.
 *
 * Pure, and free of anything Workspaces means by a board or an attachment:
 * those sit behind `chat.ts`'s `VoiceAgents`.
 */
import { createHash } from 'node:crypto';

/** Said at once while the agent works, so a phone is not silent. */
export const INTERIM_LINE = 'Working on it.';

/** How long a streamed turn waits for the agent. The stream sends a comment
 *  line every `KEEPALIVE_MS`, so no proxy closes it as idle; past this a
 *  person holding a phone should be told rather than kept waiting. */
export const STREAM_WAIT_MS = 180_000;
/** How long a turn that is not streamed waits. Under the 100s after which
 *  Cloudflare closes a response that has sent no byte. */
export const PLAIN_WAIT_MS = 90_000;
export const KEEPALIVE_MS = 15_000;

/** The longest turn read, and the most earlier turns passed on. */
export const TURN_MAX = 4000;
export const HISTORY_KEEP = 12;
export const HISTORY_TURN_MAX = 1000;
const MESSAGES_MAX = 200;

const MODEL_ID = /^[^\s/\\]{1,200}$/;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface HistoryTurn {
  from: 'owner' | 'agent';
  text: string;
}

export interface ChatTurn {
  model: string;
  /** The newest user message: what this turn says. */
  text: string;
  /** The user and assistant messages before it, oldest first, capped. */
  history: HistoryTurn[];
  conversationId: string;
  stream: boolean;
}

export interface ApiError {
  status: number;
  body: { error: { message: string; type: string; code: string } };
}

export function apiError(status: number, code: string, message: string): ApiError {
  const type = status === 401 ? 'authentication_error' : 'invalid_request_error';
  return { status, body: { error: { message, type, code } } };
}

/** A message's text: a string, or the text parts of a content array. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) =>
      p && typeof p === 'object' && (p as { type?: unknown }).type === 'text'
        ? String((p as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

/** What an assistant message said, without the line said while waiting. */
function spoken(text: string): string {
  const t = text.trim();
  return t.startsWith(INTERIM_LINE) ? t.slice(INTERIM_LINE.length).trim() : t;
}

/** `caller` is whatever tells two clients apart (the token's id), so two
 *  people's chats that open with the same words never share an id. */
export function conversationIdFor(
  model: string,
  firstUser: string,
  header: string | null,
  caller = '',
): string {
  if (header && CONVERSATION_ID.test(header)) return header;
  const h = createHash('sha256').update(`${caller}\0${model}\0${firstUser}`).digest('hex');
  return `vc-${h.slice(0, 20)}`;
}

/** The request body, or the error to answer with. */
export function parseChatRequest(
  body: unknown,
  conversationHeader: string | null,
  caller = '',
): ChatTurn | ApiError {
  if (!body || typeof body !== 'object')
    return apiError(400, 'invalid_body', 'Send a JSON object.');
  const b = body as Record<string, unknown>;
  if (typeof b.model !== 'string' || !MODEL_ID.test(b.model)) {
    return apiError(400, 'invalid_model', 'model names the agent: an id from GET /v1/models.');
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0 || b.messages.length > MESSAGES_MAX) {
    return apiError(400, 'invalid_messages', `messages is an array of 1 to ${MESSAGES_MAX}.`);
  }
  const messages = b.messages.map((m) => {
    const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
    return { role: typeof o.role === 'string' ? o.role : '', text: textOf(o.content) };
  });
  const last = messages.at(-1);
  const text = last?.text.trim() ?? '';
  if (last?.role !== 'user' || !text) {
    return apiError(400, 'invalid_messages', 'The last message is the user’s turn, with text.');
  }
  if (text.length > TURN_MAX) {
    return apiError(400, 'turn_too_long', `A turn is at most ${TURN_MAX} characters.`);
  }
  const history = messages
    .slice(0, -1)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      from: m.role === 'user' ? ('owner' as const) : ('agent' as const),
      text: (m.role === 'assistant' ? spoken(m.text) : m.text.trim()).slice(0, HISTORY_TURN_MAX),
    }))
    .filter((t) => t.text)
    .slice(-HISTORY_KEEP);
  const firstUser = messages.find((m) => m.role === 'user')?.text.trim() ?? text;
  return {
    model: b.model,
    text,
    history,
    conversationId: conversationIdFor(b.model, firstUser, conversationHeader, caller),
    stream: b.stream === true,
  };
}

export interface ModelEntry {
  id: string;
  name: string;
  description: string;
}

/** `GET /v1/models`. `name` and `description` are read by clients that show
 *  more than the id; plain OpenAI clients ignore them. */
export function modelList(models: ModelEntry[]) {
  return {
    object: 'list' as const,
    data: models.map((m) => ({
      id: m.id,
      object: 'model' as const,
      created: 0,
      owned_by: 'workspaces',
      name: m.name,
      description: m.description,
    })),
  };
}

/** A whole answer, for a turn that is not streamed. */
export function completion(id: string, model: string, created: number, text: string) {
  return {
    id,
    object: 'chat.completion' as const,
    created,
    model,
    choices: [
      { index: 0, message: { role: 'assistant' as const, content: text }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** One server-sent event of a streamed answer. */
export function chunk(
  id: string,
  model: string,
  created: number,
  delta: { role?: 'assistant'; content?: string },
  finish: 'stop' | null = null,
): string {
  const body = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

export const STREAM_DONE = 'data: [DONE]\n\n';
export const KEEPALIVE = ': keepalive\n\n';

/** A bearer from `Authorization`, whatever its scheme's case. */
export function bearerOf(headers: Headers): string | null {
  const m = headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1] ?? null;
}
