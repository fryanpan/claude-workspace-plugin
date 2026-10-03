/**
 * Where a doc thread on a queue row opens: the doc at the comment.
 *
 * A markdown doc opens in the editor (`docs/`), a mock opens as the page it
 * is (`mockups/`), and an app opens the page the thread is pinned to
 * (`apps/`, the row's `pageUrl`), each with `?thread=` so the thread is
 * selected on arrival. Home's opener and the cross-board review both link
 * here, so the two cannot send the same row to different places.
 */
import { pageThreadHref } from '@claude-workspaces/core/page-thread-link';
import type { ReviewThreadItem } from './board-review-model.ts';

export function docThreadHref(
  workspaceId: string,
  t: Pick<ReviewThreadItem, 'docId' | 'docType' | 'pageUrl' | 'threadId'>,
): string {
  const board = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const doc = encodeURIComponent(t.docId);
  if (t.docType === 'app') return pageThreadHref(`${board}/apps/${doc}/`, t.threadId, t.pageUrl);
  // `docType` is absent on an older server's payload, which reads as `docs/`.
  const surface = t.docType === 'mockup' ? 'mockups' : 'docs';
  return pageThreadHref(`${board}/${surface}/${doc}`, t.threadId);
}
