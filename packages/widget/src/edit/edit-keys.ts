/**
 * What the reviewer's keys do inside the element being edited, beyond
 * typing: the line breaks that make paragraphs, the three marks an edit can
 * carry, and a paste that brings words only. `edit-mode.ts` calls these with
 * the element it made editable.
 *
 * Formatting is keys and nothing on screen (calm by default): Cmd-B bold,
 * Cmd-I italic, Cmd-K a link — Ctrl off a Mac. On an iPad without a
 * keyboard, the system's own text menu offers bold and italic in an
 * editable element.
 */

/** Cmd-K: link the selected words, or change or (left empty) remove the
 *  link the caret is in. The browser's own prompt asks for the address; the
 *  selection is put back first, since the prompt took focus. */
function link(el: HTMLElement): void {
  const sel = getSelection();
  const range = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  if (!sel || !range || !el.contains(range.commonAncestorContainer)) return;
  const at = range.startContainer;
  const a = (at instanceof Element ? at : at.parentElement)?.closest('a');
  const url = prompt('Link to (leave empty to remove the link)', a?.getAttribute('href') ?? '');
  el.focus();
  sel.removeAllRanges();
  sel.addRange(range);
  if (url === null) return;
  if (url.trim()) document.execCommand('createLink', false, url.trim());
  else document.execCommand('unlink');
}

/** A key pressed inside `el`. Enter starts a new paragraph in a paragraph
 *  and finishes the edit of anything else — a heading, a button; Shift-Enter
 *  always breaks. */
export function editingKey(ev: KeyboardEvent, el: HTMLElement): void {
  if (ev.type !== 'keydown') return;
  if (ev.key === 'Enter' && !ev.isComposing) {
    ev.preventDefault();
    if (ev.shiftKey || el.tagName === 'P') document.execCommand('insertLineBreak');
    else el.blur();
    return;
  }
  if (!(ev.metaKey || ev.ctrlKey) || ev.altKey) return;
  const k = ev.key.toLowerCase();
  if (k !== 'b' && k !== 'i' && k !== 'k') return;
  ev.preventDefault();
  if (k === 'k') link(el);
  else document.execCommand(k === 'b' ? 'bold' : 'italic');
}

/** A paste brings plain text only: markup from elsewhere is not the
 *  reviewer's formatting. */
export function plainPaste(ev: ClipboardEvent): void {
  ev.preventDefault();
  document.execCommand('insertText', false, ev.clipboardData?.getData('text/plain') ?? '');
}
