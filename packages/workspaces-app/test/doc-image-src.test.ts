import { prose } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { docAssetsBase, fromDisplaySrc, toDisplaySrc } from '../src/doc-image-src.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';

/**
 * A relative image in a bound doc is fetched from the doc's folder route, and
 * the node — which is what the server writes back to the `.md` — keeps the
 * path as written.
 */
const BASE = docAssetsBase('harborlight', 'ws-1');

const open: Array<{ handle: EditorHandle; parent: HTMLElement }> = [];
// The editor reads the board from the page's own address, as it does live.
beforeEach(() => window.history.replaceState(null, '', '/workspaces/ws-1/docs/harborlight'));
afterEach(() => {
  for (const o of open.splice(0)) {
    o.handle.destroy();
    o.parent.remove();
  }
});

function mount(md: string, imageDocId?: string) {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  fragment.push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc), imageDocId });
  open.push({ handle, parent });
  return { parent, fragment, handle };
}

describe('relative images in the editor', () => {
  it('fetches a relative path from the doc’s assets route', () => {
    const { parent } = mount('![caption](img/chart.png)\n\n![](./chart.png)\n', 'harborlight');
    const srcs = [...parent.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs).toEqual([
      '/workspaces/ws-1/docs/harborlight/assets/img/chart.png',
      '/workspaces/ws-1/docs/harborlight/assets/chart.png',
    ]);
  });

  it('keeps the path as written in the doc, so the .md keeps it', () => {
    const { fragment, handle } = mount('Riverbend\n\n![caption](img/chart.png)\n', 'harborlight');
    // A local edit makes y-prosemirror write the editor's whole state back
    // into the fragment — the path the browser's copy of the image takes.
    handle.editor.commands.insertContentAt(1, 'Saltmarsh ');
    const md = prose.serializeFragmentToMarkdown(fragment);
    expect(md).toContain('Saltmarsh Riverbend');
    expect(md).toContain('![caption](img/chart.png)');
  });

  it('leaves an absolute URL alone', () => {
    const { parent } = mount('![](https://example.com/a.png)\n', 'harborlight');
    expect(parent.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
  });
});

describe('toDisplaySrc / fromDisplaySrc', () => {
  it('maps a relative path and back, encoding each segment', () => {
    const shown = toDisplaySrc('img/a b.png', BASE);
    expect(shown).toBe(`${BASE}img/a%20b.png`);
    expect(fromDisplaySrc(shown, BASE)).toBe('img/a b.png');
  });

  it('passes schemes, root paths and anchors through', () => {
    for (const src of ['data:image/png;base64,AA', '/x.png', '//cdn/x.png', '#x', 'mailto:a']) {
      expect(toDisplaySrc(src, BASE), src).toBe(src);
    }
    expect(toDisplaySrc('a.png', undefined)).toBe('a.png');
  });
});
