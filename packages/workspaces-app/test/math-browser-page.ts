/**
 * The review editor, built for a real browser, with a doc to mount in it.
 *
 * `math-browser-driver.ts` bundles this and calls `window.cwMathMount` with a
 * doc. The editor is the SHIPPED `createEditor`, so the KaTeX it reaches for
 * is the real lazy fetch of `/app/katex/` that `math-katex.ts` makes.
 */
import { prose } from '@claude-workspaces/core';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createEditor } from '../src/editor.ts';

declare global {
  interface Window {
    cwMathMount: (markdown: string) => void;
  }
}

window.cwMathMount = (markdown) => {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(markdown));
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
};
