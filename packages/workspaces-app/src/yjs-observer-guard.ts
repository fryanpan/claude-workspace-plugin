import { Extension } from '@tiptap/core';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';

/**
 * Keeps a transaction dispatched from inside a Yjs observer from writing the
 * editor's doc back to Yjs.
 *
 * Every ProseMirror transaction, even one that only sets a meta for a
 * decoration, makes y-prosemirror write the editor's WHOLE doc back to the
 * Y.XmlFragment as a diff. That is safe only while the two agree. Inside a
 * Yjs transaction's observer calls they may not: Yjs calls a type's own
 * observers before the deep ones, and y-prosemirror redraws the editor from
 * a deep observer on the fragment. So an observer on `meta` or `threads`
 * that dispatches, in a transaction that also changed the fragment, runs
 * while the editor still shows the doc from before the change, and the
 * write-back re-inserts whatever the change removed.
 *
 * One transaction carrying all of that is what a reconnect's sync step 2 is:
 * everything the tab missed, applied at once. On 3 Oct that re-inserted an
 * agent's 41 deleted blocks and its 5 rejected suggestions, and the file
 * followed. The plan placeholder's `meta` observer was the dispatcher.
 *
 * So a dispatch made during an observer phase runs inside the sync binding's
 * mutex, which is how y-prosemirror marks its own redraws: the transaction
 * applies, and the write-back skips it. If the fragment did change, the
 * binding's own observer redraws the editor next, in the same phase. Guarded
 * here rather than at each observer because any observer that dispatches has
 * the same fault, and the comment list's does.
 */
interface GuardStorage {
  /** Between a Yjs transaction's `beforeObserverCalls` and its end. */
  observing: boolean;
  dispose: (() => void) | null;
}

export const YjsObserverGuard = Extension.create<{ ydoc: Y.Doc | null }, GuardStorage>({
  name: 'yjsObserverGuard',

  addOptions() {
    return { ydoc: null };
  },

  addStorage() {
    return { observing: false, dispose: null };
  },

  // Before, not on, create: tiptap fires `create` a tick after the view
  // exists, and a sync can land inside that tick.
  onBeforeCreate() {
    const ydoc = this.options.ydoc;
    if (!ydoc) return;
    const enter = () => {
      this.storage.observing = true;
    };
    const leave = () => {
      this.storage.observing = false;
    };
    // `afterTransaction` closes the observer calls; the cleanup event is a
    // second exit in case an observer threw past it.
    ydoc.on('beforeObserverCalls', enter);
    ydoc.on('afterTransaction', leave);
    ydoc.on('afterTransactionCleanup', leave);
    this.storage.dispose = () => {
      ydoc.off('beforeObserverCalls', enter);
      ydoc.off('afterTransaction', leave);
      ydoc.off('afterTransactionCleanup', leave);
    };
  },

  onDestroy() {
    this.storage.dispose?.();
    this.storage.dispose = null;
  },

  dispatchTransaction({ transaction, next }) {
    const binding = this.storage.observing
      ? ySyncPluginKey.getState(this.editor.state)?.binding
      : undefined;
    if (!binding || transaction.getMeta(ySyncPluginKey)) {
      next(transaction);
      return;
    }
    // Already held means this dispatch is inside the binding's own work,
    // which it already keeps from writing back.
    binding.mux(
      () => next(transaction),
      () => next(transaction),
    );
  },
});
