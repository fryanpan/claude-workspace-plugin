/**
 * `/mcp` — the hosted MCP connector, for Claude Code sessions on this machine.
 *
 * What answers is connector/host.ts. This module decides only the path and who
 * may reach it, and the answer to the second is: an agent process on this
 * machine, and nothing else.
 *
 * The endpoint is every agent-only door at once. Through it a caller reads
 * the event stream of whatever agent its headers name and calls every tool as
 * that agent, so it takes the refusals those doors take — never through the
 * edge, never from off this machine, never from a page — in the same function
 * (`refuseNonLocalAgentCaller`), so a check added there reaches this door too.
 * A share visitor is refused before any of them, as the agent stream refuses
 * one: nothing here is scoped to a board.
 *
 * And it asks for the agent token those doors ask for, through the same
 * `authorizeAgentCaller`. A loopback caller can no longer mint a token for any
 * agent — the mint checks which session holds the socket
 * (auth/agent-caller.ts) — so the token is what proves a caller is the agent
 * it names, here as on `/events/agent/<id>`. Unlike those doors it has no
 * deprecation window: a request naming a named agent without that agent's
 * token is refused whether or not `CW_REQUIRE_AGENT_TOKEN` is on. The window
 * exists for bundles that predate the token, and no such bundle ever spoke
 * to this door — its one client is the relay (packages/plugin/relay/), which
 * mints before it initializes (`GET /api/agent-token`, routes/agent-identity.ts).
 * The agent checked is every one the request
 * could act as: the one its headers name, and the one its `Mcp-Session-Id`
 * was opened as, so a session id cannot carry a caller into someone else's
 * session. The shared unnamed identity has no token and needs none: it is
 * keyed per session, so it reaches nobody else's feed.
 *
 * The connector it hosts mints in-process for every REST call it makes on the
 * agent's behalf, so those routes are gated exactly as they were for the stdio
 * child.
 */
import { authorizeAgentCaller, refuseNonLocalAgentCaller } from '../auth/agent-token.ts';
import type { ConnectorHost } from '../connector/host.ts';
import { readIdentityHeaders, resolveIdentity } from '../connector/identity.ts';

export interface McpConnectorRouteContext {
  host: ConnectorHost;
  j: (status: number, body: unknown) => Response;
  /** The request's SOCKET address, never a header. */
  requestAddress: (req: Request) => string | undefined;
  /** The key the `at1` agent bearer verifies under. See auth/agent-token.ts. */
  agentTokenKey: () => string;
}

export const MCP_CONNECTOR_PATH = '/mcp';

/**
 * Every named agent this request could act as. Headers the host will refuse
 * name nobody here; the host answers them with its own 400.
 */
function agentsNamedBy(host: ConnectorHost, req: Request): Set<string> {
  const ids = new Set<string>();
  const sid = req.headers.get('mcp-session-id');
  const live = sid ? host.sessionIdentity(sid) : undefined;
  if (live && !live.shared) ids.add(live.author.id);
  const read = readIdentityHeaders(req.headers);
  const resolved = read.ok ? resolveIdentity(read.headers, sid ?? '') : null;
  if (resolved?.ok && !resolved.identity.shared) ids.add(resolved.identity.author.id);
  return ids;
}

export async function handleMcpConnectorRoute(
  ctx: McpConnectorRouteContext,
  input: { req: Request; pathname: string; visitor: unknown },
): Promise<Response | null> {
  if (input.pathname !== MCP_CONNECTOR_PATH) return null;
  if (input.visitor) return ctx.j(403, { error: 'not available to share visitors' });
  const address = ctx.requestAddress(input.req);
  const refused = refuseNonLocalAgentCaller(input.req, address);
  if (refused) return ctx.j(refused.status, refused.body);
  for (const agentId of agentsNamedBy(ctx.host, input.req)) {
    const allowed = authorizeAgentCaller({
      agentId,
      req: input.req,
      address,
      key: ctx.agentTokenKey(),
      requireToken: true,
    });
    if (!allowed.ok) return ctx.j(allowed.status, allowed.body);
  }
  return ctx.host.handle(input.req);
}
