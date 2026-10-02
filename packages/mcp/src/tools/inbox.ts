/**
 * `post_inbox_rows` — the inbox reader's one verb: a pass of Incoming
 * Messages rows, upserted by source thread id (`POST /inbox/rows`).
 *
 * Only the reader the server's inbox config names may call it, and only with
 * its own agent token; any other caller is refused by the server, not here.
 * The arguments are forwarded as given — the server checks every field — so
 * this arm adds nothing a hostile caller could lean on.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AgentAuthor } from '../author.ts';

export interface InboxToolContext {
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  ok: (data: unknown) => CallToolResult;
  err: (message: string) => CallToolResult;
  AUTHOR: AgentAuthor;
}

export async function handleInboxTool(
  name: string,
  a: Record<string, unknown>,
  ctx: InboxToolContext,
): Promise<CallToolResult | undefined> {
  switch (name) {
    case 'post_inbox_rows': {
      const { pass, rows } = a;
      if (typeof pass !== 'string' || pass === '') return ctx.err('pass is required');
      if (!Array.isArray(rows) || rows.length === 0)
        return ctx.err('rows must be a non-empty list');
      const res = await ctx.http('POST', '/inbox/rows', { agentId: ctx.AUTHOR.id, pass, rows });
      return ctx.ok(res);
    }
    default:
      return undefined;
  }
}
