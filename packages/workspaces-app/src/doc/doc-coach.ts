/**
 * The coach's card on every doc page: a markdown doc, a folder's file, a
 * diff and its members, code. Mounted once per navigation for every surface
 * the doc page routes to, so none of them is left without it; the router's
 * scope takes it down on the next navigation, and the next page's card is
 * drawn from the stream's first frame.
 *
 * On a markdown doc the coach also hears where in the doc he is reading and
 * what he writes, so it is handed the editor. Elsewhere it hears only which
 * doc. It stops itself for anyone but the owner (`coach-card.ts`).
 */
import { mountCoachCard } from '../coach-card.ts';
import { currentWorkspaceId } from '../doc-path.ts';
import type { MountContext } from '../mount-context.ts';

export function mountDocCoach(ctx: MountContext): void {
  const workspaceId = currentWorkspaceId() ?? ctx.workspaceId;
  if (!workspaceId) return;
  const editor = ctx.docType === 'markdown' ? document.getElementById('editor') : null;
  const coach = mountCoachCard({
    workspaceId,
    docId: ctx.navDocId ?? ctx.docId,
    ...(editor ? { root: editor } : {}),
  });
  ctx.scope.onCleanup(() => coach.destroy());
}
