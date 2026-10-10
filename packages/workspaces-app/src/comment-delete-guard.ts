import { Extension } from '@tiptap/core';
import { AllSelection, type EditorState, Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * Delete and Backspace do nothing to a selection that spans blocks when the
 * reader's last move was a tap on a comment.
 *
 * A tap on a comment's highlight opens the thread AND puts the caret in the
 * prose (`placeCaretAtPoint`), so a select-all reached from there — a
 * keyboard's Cmd+A, or Select All in the iPad's menu — takes the whole doc,
 * and the next Delete removed every block of it. The owner did exactly that on
 * 10 Oct, and the empty doc then flushed over the bound file.
 *
 * The rule is narrow on purpose. It holds only from the tap until the reader
 * does anything of their own — another tap, an edit, any key but a modifier,
 * select-all or the two delete keys — so a caret the tap placed still deletes
 * one character, a word double-tapped inside the highlight still goes, and a
 * selection the reader then drew by hand deletes as usual. A select-all from
 * plain prose is a person clearing the doc on purpose and is not refused; the
 * Undo toast (`mass-delete-undo.ts`) is what answers a mistake there.
 */

const MODIFIERS = new Set(['Meta', 'Control', 'Shift', 'Alt', 'OS']);

function isDeleteKey(key: string): boolean {
  return key === 'Backspace' || key === 'Delete';
}

/** The reader asking for all of it: Cmd/Ctrl+A. */
function isSelectAll(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a';
}

/** Whether the selection reaches past the top-level block its start is in. */
function spansBlocks(state: EditorState): boolean {
  const sel = state.selection;
  if (sel instanceof AllSelection) return true;
  if (sel.empty) return false;
  return sel.$from.index(0) !== sel.$to.index(0);
}

export const CommentDeleteGuard = Extension.create({
  name: 'commentDeleteGuard',
  // Ahead of every keymap, so Backspace never reaches `deleteSelection`.
  priority: 1000,
  addProseMirrorPlugins() {
    // Set by a press on a comment's highlight; cleared by the reader's next
    // move of their own. Per editor, because the closure is.
    let fromComment = false;
    const onPress = (_view: unknown, event: Event): boolean => {
      const target = event.target as Element | null;
      fromComment = target?.closest?.('.thread-range') != null;
      return false;
    };
    return [
      new Plugin({
        key: new PluginKey('commentDeleteGuard'),
        view: () => ({
          update: (view, prev) => {
            if (!prev.doc.eq(view.state.doc)) fromComment = false;
          },
        }),
        props: {
          handleKeyDown(view, event) {
            if (!fromComment) return false;
            if (isDeleteKey(event.key)) return spansBlocks(view.state);
            if (!MODIFIERS.has(event.key) && !isSelectAll(event)) fromComment = false;
            return false;
          },
          handleDOMEvents: {
            pointerdown: onPress,
            mousedown: onPress,
            touchstart: onPress,
            // The on-screen keyboard's delete can arrive without a keydown the
            // editor sees; the browser's own edit is refused the same way.
            beforeinput(view, event) {
              if (!fromComment || !event.inputType.startsWith('delete')) return false;
              if (!spansBlocks(view.state)) return false;
              event.preventDefault();
              return true;
            },
          },
        },
      }),
    ];
  },
});
