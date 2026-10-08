/**
 * ── The voice page: talk to any agent on the owner's boards ──
 *
 *   GET /voice?agent=<id>[&board=<ws>]  the page; starts on that agent
 *   GET /api/voice/agents               the boards and their agents
 *
 * Top-level for the review queue's reason: it is about every board. The talk
 * itself is each board's own converse socket with `start.agent` set
 * (`spoken-reply/agent-conversation.ts`), so the page adds no audio path and
 * no write route.
 *
 * The owner's alone, gated exactly as that socket is: a share or collab
 * visitor is refused, a proven person who is not the owner is refused, and a
 * browser that proved nobody gets 401 from the list when this server asks for
 * sign-in. Anything else that proved nobody is the trusted-local caller every
 * board route already serves.
 */
import { signInRequiredBody } from '../middleware/write-gate.ts';
import type { VoiceBoard } from '../voice-agent-list.ts';

export interface VoicePageRoutesContext {
  agents: () => VoiceBoard[];
  renderPage: () => string;
  pageHeaders: Record<string, string>;
  j: (status: number, body: unknown) => Response;
}

export interface VoicePageRouteRequest {
  req: Request;
  pathname: string;
  /** Truthy for a share or collaboration visitor. */
  visitor: unknown;
  ownerProven: () => boolean;
  /** A person proof exists, whoever it names. */
  anyoneProven: () => boolean;
  /** This server asks for sign-in, and this browser proved nobody: the
   *  converse socket's own read-only test (`upgrade-stream.ts`). */
  mustSignIn: () => boolean;
}

const PAGE = '/voice';
const LIST = '/api/voice/agents';

/** Null when the caller is the owner, else the refusal. */
export function refuseNonOwner(
  ctx: VoicePageRoutesContext,
  rq: VoicePageRouteRequest,
): Response | null {
  if (rq.visitor) return ctx.j(403, { error: 'not available to share visitors' });
  if (rq.ownerProven()) return null;
  if (rq.anyoneProven()) {
    return ctx.j(403, { error: 'owner-only', message: 'Only the owner can talk to agents here.' });
  }
  if (rq.mustSignIn()) return ctx.j(401, signInRequiredBody());
  return null;
}

export function handleVoicePageRoutes(
  ctx: VoicePageRoutesContext,
  rq: VoicePageRouteRequest,
): Response | null {
  if (rq.pathname !== PAGE && rq.pathname !== LIST) return null;
  if (rq.req.method !== 'GET') return ctx.j(405, { error: 'method not allowed' });
  if (rq.pathname === LIST) {
    const denied = refuseNonOwner(ctx, rq);
    return denied ?? ctx.j(200, { boards: ctx.agents() });
  }
  // The shell holds nothing but markup, so a browser that has not signed in
  // yet gets it and is told by the list's 401; under access-only there is no
  // sign-in page to send it to. A visitor and a proven non-owner get nothing.
  if (rq.visitor || (rq.anyoneProven() && !rq.ownerProven())) {
    return refuseNonOwner(ctx, rq);
  }
  return new Response(ctx.renderPage(), { headers: ctx.pageHeaders });
}
