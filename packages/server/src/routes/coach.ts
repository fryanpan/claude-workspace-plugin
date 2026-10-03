/**
 * ── The coach: Bryan's learning goals, where he is, and his answers ──
 *
 *   POST /coach/setup                make the learning-goals doc, once → `{ url }`
 *   POST /coach/goals/add            add a goal's four empty parts to it
 *   POST /coach/review               `{ answer: 'no-update' }` to the weekly offer
 *   POST /coach/prefs                `{ spacing: 'less' | 'normal' | 'more' }`
 *   POST /coach/here                 where he is: `{ workspaceId, docId?, visible,
 *                                    scrollPct?, heading?, timeZone? }`
 *   GET  /coach/stream               the moments, as server-sent events
 *   POST /coach/moments/:id/answer   `{ answer: 'thanks' | 'not-now' | 'not-this' }`
 *   POST /coach/check                judge now, from this machine only
 *   POST /coach/candidates/:id/reply the coach session's verdict on a candidate,
 *                                    from this machine only
 *
 * Owner-level, not under a board: everything here is Bryan's, so nothing is
 * on a share or member allowlist and a visitor is refused before anything
 * is read.
 *
 *  - Every page route is for Bryan alone: a person proof that resolves to
 *    the owner, from this server's own pages. A POST must also carry this
 *    origin; the stream is a GET, which a browser sends without one, so it
 *    asks for the same-origin fetch mark alone. The gate is Incoming
 *    Messages' (`routes/inbox.ts`), repeated rather than imported so neither
 *    family reaches into the other.
 *  - `/coach/here` answers anyone but the owner with an empty 204, which
 *    the page reads as "stop": every board and doc page sends it.
 *  - The check is for a process on this machine (`refuseNonLocal`). It
 *    passes every gate a trigger does, including at most one judgement in
 *    twenty minutes, so a loop here cannot run up the bill.
 *
 * Nothing here reaches an agent's stream.
 */
import type { AgentCallerVerdict } from '../auth/agent-token.ts';
import { addGoal, ensureGoalsDoc } from '../coach/setup.ts';
import {
  COACH_SPACINGS,
  type CoachSpacing,
  MOMENT_ANSWERS,
  type MomentAnswer,
} from '../coach/types.ts';
import type { CoachWiring } from '../coach/wiring.ts';

export interface CoachRoutesContext {
  wiring: CoachWiring;
  boardExists: (workspaceId: string) => boolean;
  docOnBoard: (workspaceId: string, docId: string) => boolean;
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

const MAX_BODY_BYTES = 4_000;
const ANSWER_PATH = /^\/coach\/moments\/(cm-[A-Za-z0-9_-]{12})\/answer$/;
const REPLY_PATH = /^\/coach\/candidates\/([^/]+)\/reply$/;
const ID = /^[A-Za-z0-9_:.-]{1,128}$/;
const HEADING_CHARS = 120;

/** Bryan's own pages, and nobody else's. */
function refuseNonOwner(ctx: CoachRoutesContext, rq: CoachRouteRequest): Response | null {
  const { j } = ctx;
  if (rq.visitor) return j(403, { error: 'not available to share visitors' });
  if (!rq.ownerProven()) {
    return j(403, {
      error: 'owner-proof-required',
      message: 'Only the owner, signed in, has a coach.',
    });
  }
  if (rq.req.headers.get('sec-fetch-site') !== 'same-origin') {
    return j(403, { error: 'same-origin-only', message: 'Use this server’s own pages.' });
  }
  if (rq.req.method !== 'GET') {
    const own = rq.requestOrigin();
    if (own === undefined || rq.req.headers.get('origin') !== own) {
      return j(403, { error: 'same-origin-only', message: 'Use this server’s own pages.' });
    }
  }
  return null;
}

const tooLarge = (req: Request): boolean => {
  const length = Number(req.headers.get('content-length') ?? '0');
  return !Number.isFinite(length) || length > MAX_BODY_BYTES;
};

/** The where-I-am body, or the reason it is refused. */
function parseHere(
  ctx: CoachRoutesContext,
  body: Record<string, unknown> | null,
):
  | { workspaceId: string; docId?: string; visible: boolean; scrollPct?: number; heading?: string }
  | string {
  const ws = body?.workspaceId;
  if (typeof ws !== 'string' || !ID.test(ws) || !ctx.boardExists(ws)) return 'unknown board';
  const doc = body?.docId;
  if (doc !== undefined && (typeof doc !== 'string' || !ID.test(doc) || !ctx.docOnBoard(ws, doc))) {
    return 'unknown doc';
  }
  if (typeof body?.visible !== 'boolean') return 'visible must be true or false';
  const pct = body?.scrollPct;
  if (
    pct !== undefined &&
    (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 0 || pct > 100)
  ) {
    return 'scrollPct is a whole number from 0 to 100';
  }
  const heading = body?.heading;
  if (heading !== undefined && typeof heading !== 'string') return 'heading must be text';
  return {
    workspaceId: ws,
    ...(typeof doc === 'string' ? { docId: doc } : {}),
    visible: body.visible,
    ...(typeof pct === 'number' ? { scrollPct: pct } : {}),
    ...(typeof heading === 'string' && heading.trim()
      ? { heading: heading.replace(/\s+/g, ' ').trim().slice(0, HEADING_CHARS) }
      : {}),
  };
}

export async function handleCoachRoutes(
  ctx: CoachRoutesContext,
  rq: CoachRouteRequest,
): Promise<Response | undefined> {
  const { pathname, req } = rq;
  if (!pathname.startsWith('/coach/')) return undefined;
  const { j } = ctx;
  const { store, coach, hub, setup } = ctx.wiring;
  const now = ctx.now ?? Date.now;

  if (pathname === '/coach/stream') {
    if (req.method !== 'GET') return j(405, { error: 'method not allowed' });
    const denied = refuseNonOwner(ctx, rq);
    if (denied) return denied;
    return hub.open(coach.openFrame());
  }
  if (req.method !== 'POST') return j(405, { error: 'method not allowed' });

  const reply = pathname.match(REPLY_PATH);
  if (reply) {
    // The session's verdict. It is checked like a model's reply would be:
    // the quote, the spacing and the cap all run in the coach.
    if (rq.visitor) return j(403, { error: 'not available to share visitors' });
    const notLocal = ctx.refuseNonLocal(req);
    if (notLocal) return j(notLocal.status, notLocal.body);
    if (tooLarge(req)) return j(413, { error: 'too-large' });
    const verdict = await ctx.safeJson(req);
    if (!verdict)
      return j(400, { error: 'bad-reply', message: 'send the verdict as a JSON object' });
    if (!ctx.wiring.judge.reply(reply[1] ?? '', JSON.stringify(verdict))) {
      return j(404, {
        error: 'no-such-candidate',
        message: 'unknown, already answered, or lapsed',
      });
    }
    return j(200, { ok: true });
  }

  if (pathname === '/coach/check') {
    if (rq.visitor) return j(403, { error: 'not available to share visitors' });
    const notLocal = ctx.refuseNonLocal(req);
    if (notLocal) return j(notLocal.status, notLocal.body);
    return j(200, await coach.judgeNow());
  }

  // Every board and doc page sends where he is, whoever is reading it, and
  // only the owner's is used. Anyone else's gets an empty answer that the
  // page reads as "no coach here", so it stops, and a reader's console shows
  // no refusal for a feature that was never theirs.
  if (pathname === '/coach/here' && (rq.visitor || !rq.ownerProven())) {
    return new Response(null, { status: 204 });
  }
  const denied = refuseNonOwner(ctx, rq);
  if (denied) return denied;
  if (tooLarge(req)) return j(413, { error: 'too-large' });
  const body = await ctx.safeJson(req);

  if (pathname === '/coach/setup') {
    const doc = await ensureGoalsDoc(store, setup, now());
    if (!doc) return j(500, { error: 'setup-failed', message: 'The goals doc could not be made.' });
    return j(200, {
      url: `/workspaces/${encodeURIComponent(doc.workspaceId)}/docs/${encodeURIComponent(doc.docId)}`,
    });
  }
  if (pathname === '/coach/goals/add') {
    if (!store.goalsDoc) return j(409, { error: 'not-set-up' });
    return addGoal(store, setup) ? j(200, { ok: true }) : j(500, { error: 'add-failed' });
  }
  if (pathname === '/coach/review') {
    if (body?.answer !== 'no-update')
      return j(400, { error: 'bad-answer', message: 'answer is no-update' });
    store.declineReview(now());
    return j(200, { ok: true });
  }
  if (pathname === '/coach/prefs') {
    const spacing = body?.spacing;
    if (!COACH_SPACINGS.includes(spacing as CoachSpacing)) {
      return j(400, {
        error: 'bad-spacing',
        message: `spacing is one of ${COACH_SPACINGS.join(', ')}`,
      });
    }
    store.setSpacing(spacing as CoachSpacing);
    return j(200, { ok: true });
  }
  if (pathname === '/coach/here') {
    const here = parseHere(ctx, body);
    if (typeof here === 'string') return j(400, { error: 'bad-here', message: here });
    store.noteTimeZone(body?.timeZone);
    coach.here(here);
    return j(200, { ok: true });
  }

  const m = pathname.match(ANSWER_PATH);
  if (!m) return j(404, { error: 'not-found' });
  const answer = body?.answer;
  if (!MOMENT_ANSWERS.includes(answer as MomentAnswer)) {
    return j(400, {
      error: 'bad-answer',
      message: `answer is one of ${MOMENT_ANSWERS.join(', ')}`,
    });
  }
  if (!coach.answer(m[1] ?? '', answer as MomentAnswer)) return j(404, { error: 'no-open-moment' });
  return j(200, { ok: true });
}
