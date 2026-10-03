/**
 * An open editor tab does not undo an edit it missed while it was offline.
 *
 * THE FAULT (prod, 3 Oct). An agent deleted 41 blocks of a bound doc and
 * rejected its 5 suggestions while a person had the doc open. Minutes later
 * the blocks and the same 5 suggestion ids were back, and the file on disk
 * with them. Reproduced on staging with a headless tab: cut the tab's socket,
 * delete over REST, let it reconnect, and within a second the tab sends an
 * ~11KB update that re-inserts everything. A tab connected the whole time
 * keeps the delete.
 *
 * THE CAUSE. A reconnect's sync step 2 delivers everything the tab missed in
 * ONE Yjs transaction, so a `meta` change and the deletes arrive together.
 * Yjs calls a type's own observers before deep ones, so the plan
 * placeholder's `meta` observer runs before y-prosemirror's fragment
 * observer has redrawn the editor, and it dispatches a transaction. Every
 * ProseMirror transaction makes y-prosemirror write the editor's whole doc
 * back to Yjs; here that doc is the one from before the deletes, so the
 * write re-inserts them, marks and all. Any observer that dispatches
 * (the comment list's decorations do too) does the same.
 *
 * The real editor is mounted because the write is y-prosemirror's, which
 * only the real sync plugin makes.
 */
import { prose } from '@claude-workspaces/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';

const REMOTE = 'server';

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
});

const MD = [
  '# Harborlight notes',
  'First paragraph stays.',
  'Second paragraph goes.',
  'Third paragraph goes.',
  'Fourth paragraph goes.',
  'Last paragraph stays.',
].join('\n\n');

/** A server doc and a tab synced to it, with every update the tab makes
 *  delivered back to the server — the socket's two halves. */
function mount() {
  const server = new Y.Doc();
  prose.getProseFragment(server).push(prose.parseMarkdownBlocks(MD));
  const tab = new Y.Doc();
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(server), REMOTE);
  const sent: Uint8Array[] = [];
  tab.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) sent.push(u);
  });
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const editor: EditorHandle = createEditor({ parent, ydoc: tab, awareness: new Awareness(tab) });
  open.push(() => editor.destroy());
  /** What the tab missed, as a reconnect's sync step 2 delivers it: one update. */
  const reconnect = () => {
    Y.applyUpdate(tab, Y.encodeStateAsUpdate(server, Y.encodeStateVector(tab)), REMOTE);
    for (const u of sent.splice(0)) Y.applyUpdate(server, u, 'tab');
  };
  return { server, tab, editor, reconnect };
}

/** The agent's edit while the tab was away: a meta write, then the deletes. */
function agentEdits(server: Y.Doc): void {
  server.getMap('meta').set('title', 'Riverbend notes');
  prose.getProseFragment(server).delete(2, 3);
}

const texts = (doc: Y.Doc): string[] =>
  prose
    .getProseFragment(doc)
    .toArray()
    .map((el) => (el as Y.XmlElement).toString());

describe('an editor tab that missed a delete', () => {
  it('keeps the delete after it reconnects', () => {
    const { server, tab, editor, reconnect } = mount();
    expect(editor.editor.state.doc.childCount).toBe(6);

    agentEdits(server);
    reconnect();

    expect(prose.getProseFragment(server).length).toBe(3);
    expect(texts(tab)).toEqual(texts(server));
    expect(editor.getText()).not.toContain('goes');
    expect(editor.editor.state.doc.childCount).toBe(3);
  });

  it('keeps it when another observer dispatches mid-sync', () => {
    const { server, tab, editor, reconnect } = mount();
    // The comment list redraws its decorations from a threads observer; this
    // stands in for it, so the guard is not one observer's fix.
    tab.getMap('threads').observeDeep(() => {
      editor.editor.view.dispatch(editor.editor.state.tr.setMeta('redraw', true));
    });

    server.getMap('threads').set('t1', new Y.Map());
    prose.getProseFragment(server).delete(2, 3);
    reconnect();

    expect(prose.getProseFragment(server).length).toBe(3);
    expect(editor.editor.state.doc.childCount).toBe(3);
  });

  it('still sends a person’s own typing', () => {
    const { server, editor, reconnect } = mount();
    editor.editor.commands.insertContentAt(1, 'Typed ');
    reconnect();
    expect(texts(server).join('')).toContain('Typed ');
  });
});
