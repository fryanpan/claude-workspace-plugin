import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { MASS_DELETE_MIN_CHARS, isMassDelete } from '../src/mass-delete-undo.ts';
import { plotChartSource } from './fixtures/plot-chart.ts';

/**
 * One local edit that removes most of the doc puts up a toast whose Undo
 * brings every word back, with the comments still on them.
 *
 * Driven through the shipped editor and the page's real `#toast`. The
 * comment is anchored the way the page anchors one — Yjs relative positions
 * read off the editor — and resolved again after the Undo, so "restores it
 * with its threads" is measured rather than assumed.
 *
 * Fixtures are fictional.
 */

const DOC = [
  '# Riverbend school trips',
  '',
  'Walking fell every year since 2005, and biking held.',
  '',
  plotChartSource(),
  '',
  'The goal line is the district target for Harborlight.',
  '',
].join('\n');

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
});

function mount(md = DOC): { handle: EditorHandle; ydoc: Y.Doc } {
  document.body.innerHTML = '<div id="toast" class="hidden"></div>';
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md, { mdx: true }));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc), editable: true });
  open.push(() => handle.destroy());
  return { handle, ydoc };
}

function posOf(handle: EditorHandle, text: string): number {
  let at = -1;
  handle.editor.state.doc.descendants((n, pos) => {
    if (at >= 0 || !n.isText) return at < 0;
    const i = (n.text ?? '').indexOf(text);
    if (i >= 0) at = pos + i;
    return false;
  });
  if (at < 0) throw new Error(`no ${text} in the doc`);
  return at;
}

const toast = () => document.getElementById('toast') as HTMLElement;
const undoButton = () => toast().querySelector<HTMLButtonElement>('.toast-action');

describe('the Undo toast after a mass delete', () => {
  it('appears after a select-all and Delete, and its Undo restores the words and the comment', () => {
    const { handle } = mount();
    const before = handle.editor.state.doc.textContent;
    const from = posOf(handle, 'biking held');
    const anchor = handle.rangeRel(from, from + 'biking held'.length);
    if (!anchor) throw new Error('no anchor');
    expect(toast().classList.contains('hidden')).toBe(true);

    handle.editor.commands.selectAll();
    handle.editor.commands.deleteSelection();
    expect(handle.editor.state.doc.textContent).toBe('');
    expect(toast().classList.contains('hidden')).toBe(false);
    expect(toast().textContent).toContain('Most of this doc was deleted.');
    expect(undoButton()?.textContent).toBe('Undo');

    undoButton()?.click();
    expect(handle.editor.state.doc.textContent).toBe(before);
    expect(toast().classList.contains('hidden')).toBe(true);
    const back = handle.resolveRel(anchor.start, anchor.end);
    expect(back && handle.editor.state.doc.textBetween(back.from, back.to)).toBe('biking held');
  });

  it('takes back edits made on the emptied doc too, until the words are back', () => {
    const { handle } = mount();
    const before = handle.editor.state.doc.textContent;
    handle.editor.commands.selectAll();
    handle.editor.commands.deleteSelection();
    // A separate undo step: the stack merges edits inside its capture window.
    const um = (
      handle.editor.state as unknown as {
        plugins: Array<{ getState: (s: unknown) => unknown }>;
      }
    ).plugins
      .map((p) => p.getState(handle.editor.state) as { undoManager?: Y.UndoManager } | undefined)
      .find((s) => s?.undoManager)?.undoManager;
    um?.stopCapturing();
    handle.editor.commands.insertContent('x');
    expect(handle.editor.state.doc.textContent).toBe('x');
    undoButton()?.click();
    expect(handle.editor.state.doc.textContent).toBe(before);
  });

  it('stays down for an ordinary delete', () => {
    const { handle } = mount();
    const from = posOf(handle, 'biking held');
    handle.editor.commands.setTextSelection({ from, to: from + 'biking held'.length });
    handle.editor.commands.deleteSelection();
    expect(toast().classList.contains('hidden')).toBe(true);
  });

  it('stays down when the same loss arrives from another copy of the doc', () => {
    const { handle, ydoc } = mount();
    const fragment = prose.getProseFragment(ydoc);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));
    remote.on('update', (u: Uint8Array) => Y.applyUpdate(ydoc, u));
    const theirs = prose.getProseFragment(remote);
    theirs.delete(0, theirs.length);
    expect(fragment.length).toBe(0);
    expect(handle.editor.state.doc.textContent).toBe('');
    expect(toast().classList.contains('hidden')).toBe(true);
  });

  it('counts a share of the doc and a floor of characters, not either alone', () => {
    expect(isMassDelete(1000, 400)).toBe(true);
    expect(isMassDelete(1000, 600)).toBe(false);
    // Most of a short draft is still under the floor.
    expect(isMassDelete(MASS_DELETE_MIN_CHARS - 1, 0)).toBe(false);
    expect(isMassDelete(MASS_DELETE_MIN_CHARS, 0)).toBe(true);
  });
});
