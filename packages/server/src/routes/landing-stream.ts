/**
 * `GET /landing/events:stream` — the workspaces list's one live stream.
 *
 * It carries a single frame, `landing.changed`, whenever a board event that
 * can change `/` has been broadcast (`landing-changes.ts` decides which). The
 * frame names no board and carries no content: the page refetches `/` and
 * reads the answer through the same gate that served it the first time.
 *
 * Gated like `/` itself: trusted-local, the default for an address
 * `shareScopeAllows` does not name. A share visitor is refused here as well,
 * since a visitor is never shown `/`.
 */
import { LANDING_CHANNEL } from '../landing-changes.ts';
import { type SseBus, openSseStream } from '../sse.ts';

export const LANDING_STREAM_PATH = '/landing/events:stream';

export interface LandingStreamRoutesContext {
  sse: SseBus;
  j: (status: number, body: unknown) => Response;
}

export function handleLandingStreamRoute(
  ctx: LandingStreamRoutesContext,
  r: { req: Request; pathname: string; visitor: unknown },
): Response | null {
  if (r.pathname !== LANDING_STREAM_PATH) return null;
  if (r.req.method !== 'GET') return ctx.j(405, { error: 'method-not-allowed' });
  if (r.visitor) return ctx.j(404, { error: 'not_found' });
  return openSseStream(ctx.sse, LANDING_CHANNEL);
}
