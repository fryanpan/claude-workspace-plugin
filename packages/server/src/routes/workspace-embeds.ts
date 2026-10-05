/**
 * The board's embed mapping: which `::name{block="…"}` doc paragraphs show a
 * live frame, and from which app (`@claude-workspaces/core/board-embeds`).
 *
 *   GET /workspaces/<ws>/embeds          → {workspaceId, embeds}
 *   PUT /workspaces/<ws>/embeds {embeds} → the same, after replacing it whole
 *
 * Trusted-local, like the parallelism cap: a share visitor never reaches it,
 * so on a shared board the visitor's doc shows the directive as plain text.
 */
import { parseBoardEmbeds } from '@claude-workspaces/core/board-embeds';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

export async function handleWorkspaceEmbeds(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { req, pathname, scope } = rq;
  if (!/^\/workspaces\/[^/]+\/embeds$/.test(pathname) || !scope) return undefined;
  if (req.method !== 'GET' && req.method !== 'PUT') return undefined;
  const { workspaceId } = scope;
  if (req.method === 'PUT') {
    const body = await ctx.safeJson(req);
    const parsed = parseBoardEmbeds(body?.embeds);
    if (!parsed.ok) return ctx.j(400, { error: parsed.error });
    if (!ctx.taskStore.setBoardEmbeds(workspaceId, parsed.embeds)) {
      return ctx.j(404, { error: 'workspace not found' });
    }
  }
  const embeds = ctx.taskStore.boardEmbeds(workspaceId);
  if (!embeds) return ctx.j(404, { error: 'workspace not found' });
  return ctx.j(200, { workspaceId, embeds });
}
