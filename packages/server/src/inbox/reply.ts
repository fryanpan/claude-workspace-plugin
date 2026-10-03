/**
 * Bryan's Send from an opened line: the checks, the one send, and the row's
 * move to `answered` with `by: owner-send`.
 *
 * The route has already proved the caller is Bryan on his own front page
 * (`routes/inbox.ts`). What is decided here, in this order:
 *
 *  1. the request holds `text` and `nonce` and nothing else, and the nonce
 *     has the shape it must;
 *  2. a nonce this row has already answered within a day gets that answer
 *     back and sends nothing, and one still in flight waits for it;
 *  3. the row exists and is open, and no other Send for it is in flight;
 *  4. the text is Bryan's as typed (`checkReplyText`);
 *  5. the destination is rebuilt from the row and the config
 *     (`reply-target.ts`), and its credential is in place;
 *  6. fewer than `MAX_SENDS_PER_HOUR` sends went out in the last hour.
 *
 * Only then does the transport send. Its outcome, the words and the answer
 * are recorded (`sends.ts`) whether it worked or not, since a failure may
 * still have reached the source. Logs name the row id and channel only.
 */
import type { InboxConfig } from './config.ts';
import { replyTargetFor } from './reply-target.ts';
import { channelName } from './section.ts';
import type { ReplyTransport } from './send-transport.ts';
import { type InboxSends, MAX_SENDS_PER_HOUR, type ReplyAnswer } from './sends.ts';
import type { InboxStore } from './store.ts';
import { checkReplyText } from './text-checks.ts';
import type { InboxRow } from './types.ts';

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const REPLY_KEYS = new Set(['text', 'nonce']);

/** What the opened line offers: Send, Messages, or why there is no Send. */
export type ReplyKind =
  | { kind: 'send' }
  | { kind: 'messages' }
  | { kind: 'unset'; message: string };

export interface ReplyDeps {
  store: InboxStore;
  sends: InboxSends;
  config: () => InboxConfig;
  transport: ReplyTransport;
  now?: () => number;
  log?: (line: string) => void;
}

const answer = (status: number, body: Record<string, unknown>): ReplyAnswer => ({ status, body });

const notSetUp = (row: InboxRow, config: InboxConfig): string =>
  `Sending isn't set up for ${channelName(row, config)} yet.`;

export class InboxReplies {
  private readonly inflight = new Map<string, Promise<ReplyAnswer>>();
  private readonly busyRows = new Set<string>();

  constructor(private readonly deps: ReplyDeps) {}

  /** For the opened line: which reply it shows. */
  kindFor(row: InboxRow): ReplyKind {
    const config = this.deps.config();
    const t = replyTargetFor(row, config);
    if (!t.ok) {
      return t.error === 'sent-in-messages'
        ? { kind: 'messages' }
        : { kind: 'unset', message: "This message can't be answered from here." };
    }
    return this.deps.transport.ready(t.target)
      ? { kind: 'send' }
      : { kind: 'unset', message: notSetUp(row, config) };
  }

  async reply(id: string, raw: unknown): Promise<ReplyAnswer> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return answer(400, { error: 'body must be a JSON object' });
    }
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some((k) => !REPLY_KEYS.has(k))) {
      return answer(400, { error: 'unknown field', message: 'A reply takes text and nonce.' });
    }
    const nonce = body.nonce;
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) return answer(400, { error: 'nonce' });
    const now = (this.deps.now ?? Date.now)();
    const first = this.deps.sends.answered(id, nonce, now);
    if (first) return first;
    const key = `${id}:${nonce}`;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const run = this.attempt(id, nonce, body.text, now);
    this.inflight.set(key, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async attempt(id: string, nonce: string, rawText: unknown, now: number) {
    const { store, sends, transport } = this.deps;
    const row = store.get(id);
    if (!row) return answer(404, { error: 'not-found' });
    if (row.state !== 'open') return answer(409, { error: 'not-open' });
    if (this.busyRows.has(id)) return answer(409, { error: 'send-in-flight' });
    const text = checkReplyText(rawText);
    if (!text.ok) return answer(400, { error: 'text', message: text.reason });
    const config = this.deps.config();
    const t = replyTargetFor(row, config);
    if (!t.ok) return answer(409, { error: t.error });
    if (!transport.ready(t.target)) {
      return answer(503, { error: 'send-not-set-up', message: notSetUp(row, config) });
    }
    if (sends.inLastHour(now) >= MAX_SENDS_PER_HOUR) {
      return answer(429, {
        error: 'too-many-sends',
        message: `At most ${MAX_SENDS_PER_HOUR} replies an hour.`,
      });
    }
    const channel = t.target.channel;
    const log = this.deps.log ?? ((l: string) => console.log(l));
    this.busyRows.add(id);
    try {
      let outcome: Awaited<ReturnType<ReplyTransport['send']>>;
      try {
        outcome = await transport.send(t.target, text.value);
      } catch {
        outcome = { ok: false, error: `${channel}: network` };
      }
      const at = (this.deps.now ?? Date.now)();
      let result: ReplyAnswer;
      if (outcome.ok) {
        store.markSent(id, { channel, upstreamId: outcome.upstreamId });
        result = answer(200, { id, state: 'answered', channel, sentAt: at });
      } else {
        result = answer(502, {
          error: 'send-failed',
          message: `Could not send on ${channelName(row, config)} (${outcome.error}).`,
        });
      }
      sends.record({
        rowId: id,
        nonce,
        at,
        channel,
        text: text.value,
        ...(outcome.ok ? { upstreamId: outcome.upstreamId } : {}),
        answer: result,
      });
      log(`[inbox] reply ${id} on ${channel}: ${outcome.ok ? 'sent' : 'failed'}`);
      return result;
    } finally {
      this.busyRows.delete(id);
    }
  }
}
