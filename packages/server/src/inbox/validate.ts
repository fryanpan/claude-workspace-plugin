/**
 * One posted row, checked field by field, before anything is stored.
 *
 * Each check refuses the ROW and leaves the rest of the post intact; the
 * route lists every refusal by index and reason. Unknown keys are refused
 * rather than ignored, so a reader cannot smuggle in a field a later version
 * of the page would render. The checks on words are `text-checks.ts`; the
 * link is `links.ts`.
 */
import type { InboxConfig } from './config.ts';
import { rebuildLink } from './links.ts';
import { checkLineText, checkSenderLabel, cleanBody } from './text-checks.ts';
import {
  ASK_KINDS,
  type AskKind,
  INBOX_SOURCES,
  type InboxGoalRef,
  type InboxRowInput,
  type InboxSource,
  REPLY_BY,
  type ReplyBy,
} from './types.ts';

const ROW_KEYS = new Set([
  'dedupeKey',
  'source',
  'workspace',
  'senderLabel',
  'senderKey',
  'senderKnown',
  'purpose',
  'body',
  'askKind',
  'replyBy',
  'stated',
  'goal',
  'link',
  'receivedAt',
  'messageCount',
  'lastFromOwner',
]);

const DEDUPE_KEY = /^(gmail|slack|messages):[A-Za-z0-9._-]{1,96}$/;
const SENDER_KEY = /^[0-9a-f]{16}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
/** How old a message may be, and how far in the future its clock may run. */
const RECEIVED_PAST_MS = 14 * DAY_MS;
const RECEIVED_FUTURE_MS = 5 * 60_000;
const STATED_AHEAD_MS = 60 * DAY_MS;

export interface ValidateContext {
  config: InboxConfig;
  now: number;
  /** Whether `goalId` is a live goal on board `workspaceId`. */
  goalIsLive: (workspaceId: string, goalId: string) => boolean;
}

export type RowVerdict =
  | { ok: true; row: InboxRowInput; body: string }
  | { ok: false; reason: string };

const refuse = (reason: string): RowVerdict => ({ ok: false, reason });

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

/** A goal the reader named, kept only when it is live; otherwise null. A
 *  stale goal is the reader's mistake, not an attack, so it never refuses. */
function goalOf(raw: unknown, ctx: ValidateContext): InboxGoalRef | null | 'bad' {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'bad';
  const g = raw as Record<string, unknown>;
  const keys = Object.keys(g);
  if (keys.length !== 2 || typeof g.workspaceId !== 'string' || typeof g.goalId !== 'string') {
    return 'bad';
  }
  if (g.workspaceId.length > 64 || g.goalId.length > 64) return 'bad';
  return ctx.goalIsLive(g.workspaceId, g.goalId)
    ? { workspaceId: g.workspaceId, goalId: g.goalId }
    : null;
}

/** `YYYY-MM-DD`, a real date, from the day the message arrived to 60 days on. */
function statedOk(raw: string, receivedAt: number): boolean {
  const m = raw.match(ISO_DATE);
  if (!m) return false;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(at).toISOString().slice(0, 10) !== raw) return false;
  const day = Math.floor(receivedAt / DAY_MS) * DAY_MS;
  return at >= day - DAY_MS && at <= receivedAt + STATED_AHEAD_MS;
}

export function validateRow(raw: unknown, ctx: ValidateContext): RowVerdict {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse('not an object');
  const r = raw as Record<string, unknown>;
  // The key itself is not echoed: nothing the reader wrote goes back out.
  if (Object.keys(r).some((k) => !ROW_KEYS.has(k))) return refuse('unknown field');

  const { dedupeKey, source, workspace } = r;
  if (typeof dedupeKey !== 'string' || !DEDUPE_KEY.test(dedupeKey)) return refuse('dedupeKey');
  if (!oneOf<InboxSource>(INBOX_SOURCES, source)) return refuse('source');
  if (!dedupeKey.startsWith(`${source}:`)) return refuse('source does not match dedupeKey');
  const ws = typeof workspace === 'string' ? ctx.config.workspaces.get(workspace) : undefined;
  if (!ws || ws.source !== source) return refuse('workspace');

  const sender = checkSenderLabel(r.senderLabel);
  if (!sender.ok) return refuse(`senderLabel: ${sender.reason}`);
  if (typeof r.senderKey !== 'string' || !SENDER_KEY.test(r.senderKey)) return refuse('senderKey');
  if (typeof r.senderKnown !== 'boolean') return refuse('senderKnown');
  const purpose = checkLineText(r.purpose, 140);
  if (!purpose.ok) return refuse(`purpose: ${purpose.reason}`);
  const body = cleanBody(r.body);
  if (!body.ok) return refuse(`body: ${body.reason}`);
  if (!oneOf<AskKind>(ASK_KINDS, r.askKind)) return refuse('askKind');
  if (!oneOf<ReplyBy>(REPLY_BY, r.replyBy)) return refuse('replyBy');

  const { receivedAt, messageCount } = r;
  if (
    typeof receivedAt !== 'number' ||
    !Number.isSafeInteger(receivedAt) ||
    receivedAt < ctx.now - RECEIVED_PAST_MS ||
    receivedAt > ctx.now + RECEIVED_FUTURE_MS
  ) {
    return refuse('receivedAt');
  }
  if (
    typeof messageCount !== 'number' ||
    !Number.isInteger(messageCount) ||
    messageCount < 1 ||
    messageCount > 500
  ) {
    return refuse('messageCount');
  }
  if (typeof r.lastFromOwner !== 'boolean') return refuse('lastFromOwner');
  if (r.stated !== undefined && (typeof r.stated !== 'string' || !statedOk(r.stated, receivedAt))) {
    return refuse('stated');
  }
  const goal = goalOf(r.goal, ctx);
  if (goal === 'bad') return refuse('goal');
  const link = rebuildLink(r.link ?? null, ws);
  if (!link.ok) return refuse(link.reason);

  return {
    ok: true,
    body: body.value,
    row: {
      dedupeKey,
      source,
      workspace: ws.key,
      senderLabel: sender.value,
      senderKey: r.senderKey,
      senderKnown: r.senderKnown,
      purpose: purpose.value,
      askKind: r.askKind,
      replyBy: r.replyBy,
      ...(typeof r.stated === 'string' ? { stated: r.stated } : {}),
      goal,
      link: link.link,
      receivedAt,
      messageCount,
      lastFromOwner: r.lastFromOwner,
    },
  };
}
