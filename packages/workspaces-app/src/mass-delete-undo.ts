import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { showToast } from './doc/chrome-dom.ts';

/**
 * An Undo toast after one local edit removes most of the doc.
 *
 * The rest of the editor stops a select-all reached from a comment
 * (`comment-delete-guard.ts`), but a person can still clear a doc on purpose
 * or by mistake, and on a bound doc the empty text reaches the file a second
 * later. Cmd+Z already undoes it; an iPad without a keyboard has no Cmd+Z, and
 * a reader who did not mean it may not know the doc is recoverable at all. So
 * the toast says what happened and offers the undo where the reader is.
 *
 * The undo is the Yjs one the editor already has, so the words come back as
 * the same document, and every comment anchored to them resolves again (Yjs
 * follows a restored item from the one that was deleted).
 *
 * Only a LOCAL edit counts: the same loss arriving from the server or another
 * reader carries the sync plugin's meta and is somebody else's to undo.
 */

/** Below this many characters removed, nothing is offered — a typo cleared
 *  out of a three-word draft is not a mass delete, whatever its share. */
export const MASS_DELETE_MIN_CHARS = 100;

/** How long the offer stays up, in ms. Longer than a bare toast's, because
 *  the reader first has to notice the doc is empty. */
export const MASS_DELETE_HOLD_MS = 15_000;

/** Undo steps the action will take back at most, looking for the words. */
const MAX_UNDO_STEPS = 20;

export interface MassDeleteUndoOptions {
  /** Shows the offer; `undo` puts the words back. Defaults to the page's
   *  toast, which a page without one simply does not show. */
  onMassDelete: (undo: () => void) => void;
}

export function isMassDelete(before: number, after: number): boolean {
  const removed = before - after;
  return removed >= MASS_DELETE_MIN_CHARS && removed * 2 > before;
}

export const MassDeleteUndo = Extension.create<MassDeleteUndoOptions>({
  name: 'massDeleteUndo',
  addOptions() {
    return {
      onMassDelete: (undo) =>
        showToast('Most of this doc was deleted.', {
          label: 'Undo',
          onAction: undo,
          holdMs: MASS_DELETE_HOLD_MS,
        }),
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const { onMassDelete } = this.options;
    return [
      new Plugin({
        key: new PluginKey('massDeleteUndo'),
        // Read where every applied transaction passes, and never append one.
        appendTransaction(trs, oldState, newState) {
          // The sizes are cached, so an ordinary keystroke stops here without
          // reading the doc's text.
          const shrunk = oldState.doc.content.size - newState.doc.content.size;
          if (shrunk < MASS_DELETE_MIN_CHARS / 2) return null;
          if (trs.some((tr) => tr.getMeta(ySyncPluginKey))) return null;
          const before = oldState.doc.textContent.length;
          if (!isMassDelete(before, newState.doc.textContent.length)) return null;
          onMassDelete(() => {
            // One step in the usual case. More only when the reader kept
            // editing the emptied doc before tapping, each edit its own step.
            for (let n = 0; n < MAX_UNDO_STEPS; n++) {
              if (editor.isDestroyed || editor.state.doc.textContent.length >= before) return;
              if (!editor.commands.undo()) return;
            }
          });
          return null;
        },
      }),
    ];
  },
});
