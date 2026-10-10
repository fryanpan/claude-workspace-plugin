import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { plotChartSource } from './fixtures/plot-chart.ts';

/**
 * Delete or Backspace right after a tap on a comment does not wipe the doc
 * (the owner, 10 Oct: "I accidentally selected the comment and then hit
 * delete but that trashed the whole doc").
 *
 * The tap puts the caret in the doc, so a select-all reached from there — a
 * keyboard's Cmd+A, or Select All in the iPad's menu — takes every block, and
 * the next Delete took them with it. `doc-wipe-browser.test.ts` measures the
 * same sequence in Chrome; this drives the shipped editor under happy-dom so
 * the rule is checked on every run, not only where a browser is allowed. That
 * a caret the tap placed still deletes one character is measured there only:
 * a collapsed Backspace is the browser's own edit, which happy-dom does not
 * make.
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

/** The editor over the doc, with a comment on `word`. */
function mount(word = 'biking held'): EditorHandle {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(DOC, { mdx: true }));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc), editable: true });
  open.push(() => handle.destroy());
  const from = posOf(handle, word);
  handle.setThreadRanges([{ id: 't1', from, to: from + word.length, status: 'open' }], null);
  return handle;
}

const text = (h: EditorHandle) => h.editor.state.doc.textContent;

/** A tap as the browser sends it, then the caret it leaves (happy-dom lays
 *  nothing out, so the caret the browser would place is set directly). */
function tap(h: EditorHandle, el: Element, caret: number): void {
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  }
  h.editor.commands.setTextSelection(caret);
}

function press(h: EditorHandle, key: string): void {
  h.editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

function selectAll(h: EditorHandle): void {
  press(h, 'Meta');
  h.editor.commands.selectAll();
}

const highlight = () => document.querySelector('.thread-range[data-thread-id="t1"]') as Element;

describe('Delete after a tap on a comment', () => {
  for (const key of ['Backspace', 'Delete']) {
    it(`${key} over a select-all reached from the comment leaves the doc whole`, () => {
      const h = mount();
      const before = text(h);
      tap(h, highlight(), posOf(h, 'biking') + 2);
      selectAll(h);
      press(h, key);
      expect(text(h)).toBe(before);
    });

    it(`${key} over a select-all from a comment in a chart's source leaves the doc whole`, () => {
      const h = mount('Trips a year');
      const before = text(h);
      tap(h, highlight(), posOf(h, 'Trips') + 2);
      selectAll(h);
      press(h, key);
      expect(text(h)).toBe(before);
    });

    it(`${key} over a select-all reached from plain prose still clears the doc`, () => {
      const h = mount();
      tap(h, document.querySelector('.ProseMirror h1') as Element, 3);
      selectAll(h);
      press(h, key);
      expect(text(h)).toBe('');
    });

    it(`${key} after the reader has moved on from the comment acts as usual`, () => {
      const h = mount();
      tap(h, highlight(), posOf(h, 'biking') + 2);
      // An arrow key is the reader's own next move, not the tap's.
      press(h, 'ArrowLeft');
      selectAll(h);
      press(h, key);
      expect(text(h)).toBe('');
    });
  }
});
