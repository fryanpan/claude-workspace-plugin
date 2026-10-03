/**
 * ── The goal coach: Bryan's goals, his answers, and a check on demand ──
 *
 *   POST /coach/goals              this week's goals, `{ goals, timeZone }`
 *   POST /coach/nudges/:id/answer  `{ answer: 'back-to-it' | 'plans-changed' }`
 *   POST /coach/check              run a check now, whatever the clock says
 *
 * Owner-level, not under a board: the goals and nudges are Bryan's, so
 * nothing here is on a share or member allowlist and a visitor is refused
 * before anything is read.
 *
 *  - The goals and the answers are for Bryan alone: a person proof that
 *    resolves to the owner, from the front page's own origin. The gate is
 *    Incoming Messages' (`routes/inbox.ts`), repeated here rather than
 *    imported so neither family reaches into the other.
 *  - The check is for a process on this machine (`refuseNonLocal`: not
 *    through the edge, not from another host, not from a page). It spends at
 *    most one model call, and a second one inside `CHECK_FLOOR_MS` is
 *    refused, so a loop on this machine cannot run up the bill.
 *
 * No event is emitted. The goals and nudges reach a page when the front
 * page loads and never reach an agent's stream.
 */
import type { AgentCallerVerdict } from '../auth/agent-token.ts';
import type { Coach } from '../coach/pass.ts';
import { type CoachStore, cleanGoals } from '../coach/store.ts';
import { NUDGE_ANSWERS, type NudgeAnswer } from '../coach/types.ts';

export interface CoachRoutesContext {
  store: CoachStore;
  coach: Coach;
  refuseNonLocal: (req: Request) => Extract<AgentCallerVerdict, { ok: false }> | null;
  j: (status: number, body: unknown) => Response;
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  now?: () => number;
}

export interface CoachRouteRequest {
  req: Request;
  pathname: string;
  visitor: unknown;
  ownerProven: () => boolean;
  requestOrigin: () => string | undefined;
}

/** The least time between two checks asked for by route. */
export const CHECK_FLOOR_MS = 10 * 60_000;
const MAX_BODY_BYTES = 8_000;
const ANSWER_PATH = /^\/coach\/nudges\/(cn-[A-Za-z0-9_-]{12})\/answer$/;

/** Bryan's own front page, and nobody else's. */
function refuseNonOwner(ctx: CoachRoutesContext, rq: CoachRouteRequest): Response | null {
  const { j } = ctx;
  if (rq.visitor) return j(403, { error: 'not available to share visitors' });
  if (!rq.ownerProven()) {
    return j(403, {
      error: 'owner-proof-required',
      message: 'Only the owner, signed in, can set goals or answer the coach.',
    });
  }
  const own = rq.requestOrigin();
  const sameSite = rq.req.headers.get('sec-fetch-site') === 'same-origin';
  if (!sameSite || own === undefined || rq.req.headers.get('origin') !== own) {
    return j(403, { error: 'same-origin-only', message: 'Use the front page itself.' });
  }
  return null;
}

const tooLarge = (req: Request): boolean => {
  const length = Number(req.headers.get('content-length') ?? '0');
  return !Number.isFinite(length) || length > MAX_BODY_BYTES;
};

export async function handleCoachRoutes(
  ctx: CoachRoutesContext,
  rq: CoachRouteRequest,
): Promise<Response | undefined> {
  const { pathname, req } = rq;
  if (!pathname.startsWith('/coach/')) return undefined;
  const { j } = ctx;
  const now = ctx.now ?? Date.now;
  if (req.method !== 'POST') return j(405, { error: 'method not allowed' });

  if (pathname === '/coach/check') {
    if (rq.visitor) return j(403, { error: 'not available to share visitors' });
    const notLocal = ctx.refuseNonLocal(req);
    if (notLocal) return j(notLocal.status, notLocal.body);
    const last = ctx.store.lastPass();
    if (last && now() - last.at < CHECK_FLOOR_MS) {
      return j(429, { error: 'too-soon', retryAfterMs: CHECK_FLOOR_MS - (now() - last.at) });
    }
    return j(200, await ctx.coach.check());
  }

  if (pathname === '/coach/goals') {
    const denied = refuseNonOwner(ctx, rq);
    if (denied) return denied;
    if (tooLarge(req)) return j(413, { error: 'too-large' });
    const body = await ctx.safeJson(req);
    const cleaned = cleanGoals(body?.goals);
    if ('error' in cleaned) return j(400, { error: 'bad-goals', message: cleaned.error });
    const tz = typeof body?.timeZone === 'string' ? body.timeZone.slice(0, 64) : undefined;
    return j(200, ctx.store.setGoals(cleaned.goals, tz, now()));
  }

  const m = pathname.match(ANSWER_PATH);
  if (!m) return j(404, { error: 'not-found' });
  const denied = refuseNonOwner(ctx, rq);
  if (denied) return denied;
  if (tooLarge(req)) return j(413, { error: 'too-large' });
  const answer = (await ctx.safeJson(req))?.answer;
  if (!NUDGE_ANSWERS.includes(answer as NudgeAnswer)) {
    return j(400, { error: 'bad-answer', message: `answer is one of ${NUDGE_ANSWERS.join(', ')}` });
  }
  if (!ctx.store.answer(m[1] ?? '', answer as NudgeAnswer, now())) {
    return j(404, { error: 'no-open-nudge' });
  }
  return j(200, { ok: true });
}
