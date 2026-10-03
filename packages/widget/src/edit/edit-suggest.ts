import { hasContext } from '@claude-workspaces/core/anchor/context';
import { createAnchor, resolve } from '@claude-workspaces/core/anchor/element';
import {
  type PageSuggestion,
  pageEditsText,
  readPageSuggestion,
  suggestedEdit,
} from '@claude-workspaces/core/page-edits';
import type { ElementAnchor } from '@claude-workspaces/core/types';
import { authedPost, httpBase } from '../widget-auth.ts';
import type { FeedbackWidgetEl } from '../widget.ts';
import { cssPath, normText } from './edit-model.ts';

/**
 * An agent's suggested words, taken or left in the thread's popover.
 *
 * The agent cannot see the page, so it names the words it would change and
 * the words it would put there (`PageSuggestion`). The popover the base
 * bundle draws for the thread gains both and two buttons:
 *
 * - **Accept** changes the words on this screen and posts the change exactly
 *   as a pencil send does: a new thread whose first comment carries
 *   `pageEdits`, which is how the agent hears it, and which wears edit mode's
 *   waiting mark until the agent applies it. The suggestion's thread is then
 *   resolved: its question is answered.
 * - **Reject** resolves the suggestion's thread and posts nothing else.
 *
 * It rides in `edit.js`, loaded at page load when a suggestion is waiting
 * (`edit-button.ts`), so the budgeted bundle carries only the thread id on
 * its popover. Calm: no motion, no badge.
 */

export const SUGGEST_CSS = [
  '.cw-sugg{margin-top:6px;padding:8px;border:1px solid #eaeef2;border-radius:6px}',
  '.cw-sugg .was{color:#8c959f;text-decoration:line-through;overflow-wrap:anywhere}',
  '.cw-sugg .now{color:#1b1f23;overflow-wrap:anywhere}',
  '.cw-sugg .now::before{content:"→ ";color:#6e7781}',
  '.cw-sugg .gone{color:#8c959f;font-style:italic}',
  '.cw-sugg-acts{display:flex;gap:6px;margin-top:8px}',
  '.cw-sugg-note{font-size:12px;color:#b45309;margin-top:6px}',
].join('');

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

interface RawThread {
  status?: unknown;
  anchor?: { kind?: unknown };
  comments?: Array<{ pageSuggestion?: unknown }>;
}

/** The suggestion a thread is still asking about, read off the raw map. */
export function openSuggestion(raw: unknown): PageSuggestion | undefined {
  const t = raw as RawThread | null;
  if (t?.status !== 'open' || t.anchor?.kind !== 'element') return undefined;
  return readPageSuggestion(t.comments?.[0]?.pageSuggestion);
}

/** Put `replacement` where the element says `find`: inside one text node
 *  when the words sit in one, so the element keeps its markup; otherwise the
 *  element's words become the edit's whole `after`. */
function replaceWords(el: HTMLElement, s: PageSuggestion, after: string): void {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const at = n.nodeValue?.indexOf(s.find) ?? -1;
    if (at < 0) continue;
    n.nodeValue =
      (n.nodeValue ?? '').slice(0, at) +
      s.replacement +
      (n.nodeValue ?? '').slice(at + s.find.length);
    return;
  }
  el.textContent = after;
}

/**
 * Accept: the change on the page, posted as a page edit, then the
 * suggestion's thread resolved. `false`, with the page untouched, when the
 * element is gone or the post is refused.
 */
export async function acceptSuggestion(
  widget: FeedbackWidgetEl,
  threadId: string,
  anchor: ElementAnchor,
  s: PageSuggestion,
): Promise<boolean> {
  const found = resolve(anchor, { root: document });
  if (!found.ok) return false;
  const el = found.element;
  const ctx = hasContext(widget.currentContext) ? { context: { ...widget.currentContext } } : {};
  const edit = suggestedEdit(
    {
      anchor: { ...createAnchor(el), ...ctx },
      selector: cssPath(el),
      before: normText(el.textContent),
    },
    s,
  );
  if (!edit) return false;
  const url =
    `${httpBase(widget)}/workspaces/${encodeURIComponent(widget.opts.workspaceId)}` +
    `/docs/${encodeURIComponent(widget.opts.docId)}/threads`;
  const res = await authedPost(widget, url, () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      author: widget.user,
      text: pageEditsText([edit]),
      anchor: edit.anchor,
      pageEdits: [edit],
    }),
  }));
  if (!res.ok) return false;
  replaceWords(el, s, edit.after);
  await widget.setStatus(threadId, 'resolved');
  return true;
}

/** Give a thread popover its suggestion block, when its thread has one. */
function decorate(widget: FeedbackWidgetEl, pop: HTMLElement): void {
  const id = pop.dataset.threadId;
  if (!id || pop.querySelector('.cw-sugg')) return;
  const raw = (
    widget.client?.ydoc.getMap('threads').get(id) as { toJSON?: () => unknown }
  )?.toJSON?.();
  const s = openSuggestion(raw);
  if (!s) return;
  const anchor = (raw as { anchor: ElementAnchor }).anchor;
  const block = document.createElement('div');
  block.className = 'cw-sugg';
  block.innerHTML =
    `<div class="was">${esc(s.find)}</div>` +
    (s.replacement === ''
      ? '<div class="gone">→ deleted</div>'
      : `<div class="now">${esc(s.replacement)}</div>`) +
    '<div class="cw-sugg-acts"><button class="primary" data-accept>Accept</button>' +
    '<button class="cancel" data-reject>Reject</button></div>';
  const note = (text: string): void => {
    const n =
      block.querySelector('.cw-sugg-note') ?? block.appendChild(document.createElement('div'));
    n.className = 'cw-sugg-note';
    n.textContent = text;
  };
  block.querySelector('[data-accept]')?.addEventListener('click', async () => {
    let done = false;
    try {
      done = await acceptSuggestion(widget, id, anchor, s);
    } catch {}
    if (done) pop.remove();
    else note('Could not accept. The page may have changed; reply instead.');
  });
  block.querySelector('[data-reject]')?.addEventListener('click', async () => {
    try {
      await widget.setStatus(id, 'resolved');
      pop.remove();
    } catch {
      note('Could not reject. Try again.');
    }
  });
  pop.querySelector('.actions')?.before(block);
}

/** Watch the widget's popovers for suggestion threads, from now on and for
 *  the one open already. */
export function mountSuggestions(widget: FeedbackWidgetEl): void {
  const shadow = widget.shadow;
  if (!shadow || shadow.querySelector('style[data-cw-sugg]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-cw-sugg', '');
  style.textContent = SUGGEST_CSS;
  shadow.append(style);
  const scan = (): void => {
    for (const pop of shadow.querySelectorAll<HTMLElement>('.thread-popover'))
      decorate(widget, pop);
  };
  new MutationObserver(scan).observe(shadow, { childList: true });
  scan();
}
