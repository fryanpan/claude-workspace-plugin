import type { Comment, ElementAnchor, Thread } from '@claude-workspaces/core';
// The receipt decision and the glyph, from the leaf module that holds them
// rather than from the app's renderer: the widget is a guest bundle with a
// gzip ceiling and cannot import `comment-view.ts`, but a second copy of
// "what does a tick mean" is how two surfaces come to disagree. Deep path,
// not the barrel — `comment-receipt.ts` imports nothing, so this drags in
// nothing behind it.
import { receiptHtml, receiptState } from '@claude-workspaces/core/comment-receipt';
import type { FeedbackWidgetEl } from './widget.ts';

/**
 * The words the widget draws a thread with, shared by the popover in the
 * budgeted bundle and the page list in `mic.js`, so the two say the same.
 */

/**
 * The line a thread row shows above its latest comment.
 *
 * A subject anchor points at the PAGE rather than into it — `create_thread`
 * with no `find` makes one on any doc — so it names that instead of quoting
 * something. Without this the row would read a snippet that isn't there.
 */
export function threadSnippet(anchor: Thread['anchor']): string {
  if (anchor.kind === 'orphan') return anchor.original.snippet.text;
  if (anchor.kind === 'subject') return 'About this page';
  return (anchor as ElementAnchor).snippet.text;
}

/**
 * The delivery mark for a comment the reader wrote, as markup, or nothing.
 *
 * Both places the widget draws a comment call this, so neither can be given a
 * mark the other lacks — the failure the shared decision exists to stop. The
 * DECISION is core's; all that is here is where the markup goes.
 */
export function receipt(c: Comment | undefined, t: Thread, el: FeedbackWidgetEl): string {
  const state = c ? receiptState(c, t.comments, el.user) : null;
  return state ? receiptHtml(state) : '';
}
