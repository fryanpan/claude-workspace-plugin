/**
 * What the reviewer's keys do inside the element being edited, beyond
 * typing: the line breaks that make paragraphs, and a paste that brings
 * words only. `edit-mode.ts` calls these with the element it made editable.
 */

/** A key pressed inside `el`. Enter starts a new paragraph in a paragraph
 *  and finishes the edit of anything else — a heading, a button; Shift-Enter
 *  always breaks. */
export function editingKey(ev: KeyboardEvent, el: HTMLElement): void {
  if (ev.type !== 'keydown') return;
  if (ev.key === 'Enter' && !ev.isComposing) {
    ev.preventDefault();
    if (ev.shiftKey || el.tagName === 'P') document.execCommand('insertLineBreak');
    else el.blur();
  }
}

/** A paste brings plain text only: markup from elsewhere is not the
 *  reviewer's formatting. */
export function plainPaste(ev: ClipboardEvent): void {
  ev.preventDefault();
  document.execCommand('insertText', false, ev.clipboardData?.getData('text/plain') ?? '');
}
