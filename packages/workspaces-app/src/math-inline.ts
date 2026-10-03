import { mathDollars } from '@claude-workspaces/core/prose-math';
import { Mark, markInputRule, mergeAttributes } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { renderTex } from './math-katex.ts';
import { type MarkdownItLike, installMathRules } from './math-markdown-it.ts';

/**
 * Inline math: the `math` mark the server's parser writes for `$x_e$`, drawn
 * with KaTeX, and opened back up to its TeX when the caret reaches it.
 *
 * The mark holds the TeX as ordinary characters, the way `code` holds code,
 * so find-and-replace, comments and the Yjs sync all treat it as text. What a
 * reader sees is render-time only, built here as decorations and never written
 * into the document: at rest the characters are folded away and a KaTeX
 * widget stands in their place; with the caret inside or against either end
 * the characters show, between muted dollar signs, and the next move away
 * draws the equation again. "Against either end" is what lets an arrow key
 * walk INTO an equation — folded characters have no caret stops of their own,
 * so the caret has to be able to land beside them first.
 *
 * A read-only doc never opens one.
 */

export interface MathRun {
  from: number;
  to: number;
  tex: string;
  dollars: number;
}

/** Every inline equation in the document, in order. Adjacent text nodes
 *  carrying the same mark (a bold word inside an equation splits it) are one
 *  equation. */
export function mathRuns(doc: ProseNode): MathRun[] {
  const out: MathRun[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let cur: MathRun | null = null;
    let off = pos + 1;
    node.forEach((child) => {
      const mark = child.isText ? child.marks.find((m) => m.type.name === 'math') : undefined;
      if (mark) {
        const dollars = mathDollars(mark.attrs);
        if (cur && cur.to === off && cur.dollars === dollars) {
          cur.to += child.nodeSize;
          cur.tex += child.text ?? '';
        } else {
          cur = { from: off, to: off + child.nodeSize, tex: child.text ?? '', dollars };
          out.push(cur);
        }
      }
      off += child.nodeSize;
    });
    return false;
  });
  return out;
}

/** A quote that holds prose and an equation keeps the equation inline, and a
 *  `$$` run that starts on its own line there was written as display math. */
function isDisplay(run: MathRun): boolean {
  return run.dollars >= 2 && run.tex.startsWith('\n');
}

function delimiter(run: MathRun): HTMLElement {
  const el = document.createElement('span');
  el.className = 'cw-math-delim';
  el.textContent = '$'.repeat(run.dollars);
  return el;
}

function rendered(view: EditorView, run: MathRun, getPos: () => number | undefined): HTMLElement {
  const el: HTMLElement = document.createElement(isDisplay(run) ? 'div' : 'span');
  el.className = 'cw-math';
  el.contentEditable = 'false';
  renderTex(el, run.tex, isDisplay(run));
  // A tap puts the caret at the end of the TeX, which opens it. Mousedown,
  // not click: the browser's own caret placement would land beside the
  // widget first and the source would open and shut under the pointer.
  el.addEventListener('mousedown', (ev: MouseEvent) => {
    if (!view.editable || ev.button !== 0) return;
    const pos = getPos();
    const live = pos == null ? undefined : mathRuns(view.state.doc).find((r) => r.from === pos);
    if (!live) return;
    ev.preventDefault();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, live.to)));
    view.focus();
  });
  return el;
}

function build(doc: ProseNode, sel: { from: number; to: number }, editable: boolean) {
  const decos: Decoration[] = [];
  for (const run of mathRuns(doc)) {
    const open = editable && sel.from <= run.to && sel.to >= run.from;
    if (open) {
      decos.push(
        Decoration.widget(run.from, () => delimiter(run), { side: -1, ignoreSelection: true }),
        Decoration.inline(run.from, run.to, { class: 'cw-math-src cw-math-open' }),
        Decoration.widget(run.to, () => delimiter(run), { side: 1, ignoreSelection: true }),
      );
      continue;
    }
    decos.push(
      Decoration.widget(run.from, (view, getPos) => rendered(view, run, getPos), {
        side: -1,
        ignoreSelection: true,
        // The same equation keeps its drawn DOM across every other edit.
        key: `cw-math:${run.dollars}:${run.tex}`,
      }),
      Decoration.inline(run.from, run.to, { class: 'cw-math-src cw-math-folded' }),
    );
  }
  return DecorationSet.create(doc, decos);
}

interface MathDecoState {
  set: DecorationSet;
  editable: boolean;
}

export const mathDecorationsKey = new PluginKey<MathDecoState>('math-decorations');

export const MathInline = Mark.create({
  name: 'math',
  // Typing after an equation writes prose, not more TeX.
  inclusive: false,
  addAttributes() {
    return {
      dollars: {
        default: 1,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-cw-math')) || 1,
        renderHTML: (attrs: Record<string, unknown>) => ({
          'data-cw-math': String(mathDollars(attrs)),
        }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-cw-math]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
  addStorage() {
    return {
      // tiptap-markdown: how pasted markdown and a redline's blocks parse.
      markdown: {
        serialize: {
          open: (_state: unknown, mark: { attrs: Record<string, unknown> }) =>
            '$'.repeat(mathDollars(mark.attrs)),
          close: (_state: unknown, mark: { attrs: Record<string, unknown> }) =>
            '$'.repeat(mathDollars(mark.attrs)),
          escape: false,
        },
        parse: {
          setup(md: MarkdownItLike) {
            installMathRules(md);
          },
        },
      },
    };
  },
  addInputRules() {
    // `$x$` typed in the editor becomes an equation when its closing dollar
    // lands. The TeX may not start or end with a space — the same rule that
    // keeps `$5 and $10` a price in the server's parser.
    return [markInputRule({ find: /(?:^|[^$\\])\$([^\s$](?:[^$]*[^\s$])?)\$$/, type: this.type })];
  },
  addProseMirrorPlugins() {
    const editable = () => this.editor.isEditable;
    const derive = (state: {
      doc: ProseNode;
      selection: { from: number; to: number };
    }): MathDecoState => ({
      set: build(state.doc, state.selection, editable()),
      editable: editable(),
    });
    return [
      new Plugin<MathDecoState>({
        key: mathDecorationsKey,
        state: {
          init: (_config, state) => derive(state),
          apply: (tr, value, oldState, newState) =>
            tr.docChanged ||
            !oldState.selection.eq(newState.selection) ||
            value.editable !== editable()
              ? derive(newState)
              : value,
        },
        props: {
          // `setEditable` arrives through `updateState`, not a transaction —
          // the same gap `footnote-decorations.ts` closes the same way.
          decorations: (state) => {
            const value = mathDecorationsKey.getState(state);
            if (!value) return null;
            return value.editable === editable() ? value.set : derive(state).set;
          },
        },
      }),
    ];
  },
});
