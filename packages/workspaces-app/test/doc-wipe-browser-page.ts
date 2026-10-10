/**
 * The review editor over an `.mdx` doc, built for a real browser, with a
 * comment highlighted in the prose and one in a chart's source, each with its
 * card in the flow the way the doc page draws them below 1100px.
 *
 * `doc-wipe-browser-driver.ts` bundles this and drives it over CDP.
 */
import { prose } from '@claude-workspaces/core';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';

declare global {
  interface Window {
    cwWipeMount: (markdown: string, words: string[]) => void;
    cwWipeRead: () => { text: string; selection: string };
  }
}

let handle: EditorHandle | null = null;

function posOf(h: EditorHandle, text: string): number {
  let at = -1;
  h.editor.state.doc.descendants((n, pos) => {
    if (at >= 0 || !n.isText) return at < 0;
    const i = (n.text ?? '').indexOf(text);
    if (i >= 0) at = pos + i;
    return false;
  });
  return at;
}

window.cwWipeMount = (markdown, words) => {
  handle?.destroy();
  document.body.innerHTML = '';
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(markdown, { mdx: true }));
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  const h = createEditor({ parent, ydoc, awareness: new Awareness(ydoc), editable: true });
  handle = h;
  const ranges = words.map((w, i) => {
    const from = posOf(h, w);
    return { id: `t${i}`, from, to: from + w.length, status: 'open' as const };
  });
  h.setThreadRanges(ranges, null);
  h.setInlineCards(
    ranges.map((r) => {
      const el = document.createElement('div');
      el.className = 'cw-inline-card';
      el.contentEditable = 'false';
      el.dataset.card = r.id;
      el.innerHTML = `<p class="card-body">Saltmarsh asked about this line, ${r.id}.</p><textarea></textarea>`;
      return { id: r.id, from: r.from, to: r.to, el };
    }),
  );
};

window.cwWipeRead = () => {
  const h = handle;
  if (!h) return { text: '', selection: '' };
  const s = h.editor.state.selection;
  return {
    text: h.editor.state.doc.textBetween(0, h.editor.state.doc.content.size, '\n'),
    selection: `${s.constructor.name} ${s.from}-${s.to}`,
  };
};
