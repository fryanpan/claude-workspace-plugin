import { prose } from '@claude-workspaces/core';
import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { MathInline } from '../src/math-inline.ts';
import { type KatexApi, setKatexForTest } from '../src/math-katex.ts';
import { MermaidCodeBlock } from '../src/mermaid-code-block.ts';

/**
 * An equation as the reader meets it in the editor: drawn by KaTeX at rest,
 * opened to its TeX when the caret reaches it, and never written back any
 * differently from how it was read.
 *
 * KaTeX itself is swapped for a recorder here — this file is about which TeX
 * reaches it and when, and a real render is the browser test's job
 * (`math-browser.test.ts`). The recorder draws a `.katex` span holding the
 * TeX it was given, so a reading of the DOM says what was rendered.
 */

const rendered: Array<{ tex: string; displayMode: boolean; trust: boolean }> = [];
const FAKE: KatexApi = {
  render(tex, el, opts) {
    rendered.push({ tex, displayMode: opts.displayMode, trust: opts.trust });
    const span = document.createElement('span');
    span.className = 'katex';
    span.textContent = tex;
    el.appendChild(span);
  },
};

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
  for (const l of document.head.querySelectorAll('link')) l.remove();
  rendered.length = 0;
  setKatexForTest(null);
});

function mount(
  md: string,
  opts: { editable?: boolean } = {},
): { editor: EditorHandle; ydoc: Y.Doc } {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const editor = createEditor({
    parent,
    ydoc,
    awareness: new Awareness(ydoc),
    editable: opts.editable ?? true,
  });
  open.push(() => editor.destroy());
  return { editor, ydoc };
}

const widgets = () => [...document.querySelectorAll<HTMLElement>('.cw-math')];
const opened = () => [...document.querySelectorAll<HTMLElement>('.cw-math-open')];

/** The position just inside the start of the first run of `text`. */
function posOf(editor: EditorHandle, text: string): number {
  let at = -1;
  editor.editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(text))
      at = pos + (node.text.indexOf(text) ?? 0);
  });
  return at;
}

const DOC = 'Energy $x_e$ and $a*b$ here.\n\n$$\n\\frac{a}{b}\n$$\n';

describe('an equation in the editor', () => {
  it('draws each inline equation with KaTeX, folding its TeX away', () => {
    setKatexForTest(FAKE);
    mount(DOC);
    expect(widgets().map((el) => el.textContent)).toEqual(['x_e', 'a*b']);
    expect(document.querySelectorAll('.cw-math-folded').length).toBe(2);
    expect(rendered.filter((r) => !r.displayMode).map((r) => r.tex)).toEqual(['x_e', 'a*b']);
  });

  it('draws a display equation from the TeX between its fences, in display mode', () => {
    setKatexForTest(FAKE);
    mount(DOC);
    const block = document.querySelector('.cm-codeblock.is-math .cm-math-display');
    expect(block?.querySelector('.katex')?.textContent).toBe('\\frac{a}{b}');
    expect(rendered.find((r) => r.displayMode)?.tex).toBe('\\frac{a}{b}');
  });

  it('never asks KaTeX to trust the TeX', () => {
    setKatexForTest(FAKE);
    mount(DOC);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.every((r) => r.trust === false)).toBe(true);
  });

  it('opens an equation to its TeX when the caret lands against it, and folds it again after', () => {
    setKatexForTest(FAKE);
    const { editor } = mount(DOC);
    const at = posOf(editor, 'x_e');
    editor.editor.commands.setTextSelection(at + 3);
    expect(opened().map((el) => el.textContent)).toEqual(['x_e']);
    expect(widgets().map((el) => el.textContent)).toEqual(['a*b']);
    expect([...document.querySelectorAll('.cw-math-delim')].map((el) => el.textContent)).toEqual([
      '$',
      '$',
    ]);
    editor.editor.commands.setTextSelection(at + 6);
    expect(opened()).toEqual([]);
    expect(widgets().length).toBe(2);
  });

  it('opens nothing in a doc the reader cannot edit', () => {
    setKatexForTest(FAKE);
    const { editor } = mount(DOC, { editable: false });
    editor.editor.commands.setTextSelection(posOf(editor, 'x_e') + 1);
    expect(opened()).toEqual([]);
    expect(widgets().length).toBe(2);
  });

  it('turns typed `$x_1$` into an equation when its closing dollar lands', () => {
    setKatexForTest(FAKE);
    const { editor, ydoc } = mount('Type here\n');
    const view = editor.editor.view;
    editor.editor.commands.setTextSelection(view.state.doc.content.size - 1);
    editor.editor.commands.insertContent(' $x_1');
    const from = view.state.selection.from;
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, from, '$', () => view.state.tr),
    );
    expect(handled).toBe(true);
    expect(prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc))).toBe(
      'Type here $x_1$\n',
    );
  });

  it('opens a display equation when `$$` and a space are typed on an empty line', () => {
    setKatexForTest(FAKE);
    const { editor, ydoc } = mount('Before\n\nAfter\n');
    const view = editor.editor.view;
    editor.editor.commands.setTextSelection(posOf(editor, 'Before') + 6);
    editor.editor.commands.splitBlock();
    editor.editor.commands.insertContent('$$');
    const from = view.state.selection.from;
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, from, ' ', () => view.state.tr),
    );
    expect(handled).toBe(true);
    editor.editor.commands.insertContent('x^2');
    expect(prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc))).toBe(
      'Before\n\n$$\nx^2\n$$\n\nAfter\n',
    );
  });

  it('leaves a price typed in the editor as text', () => {
    setKatexForTest(FAKE);
    const { editor } = mount('Cost\n');
    const view = editor.editor.view;
    editor.editor.commands.setTextSelection(view.state.doc.content.size - 1);
    editor.editor.commands.insertContent(' $5 and ');
    const from = view.state.selection.from;
    view.someProp('handleTextInput', (f) => f(view, from, from, '$', () => view.state.tr));
    expect(widgets()).toEqual([]);
  });

  it('writes the doc back byte for byte after rendering and an edit elsewhere', () => {
    setKatexForTest(FAKE);
    const { editor, ydoc } = mount(DOC);
    editor.editor.commands.setTextSelection(posOf(editor, 'here') + 4);
    editor.editor.commands.insertContent(' now');
    expect(prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc))).toBe(
      DOC.replace('here.', 'here now.'),
    );
  });
});

describe('KaTeX is fetched only for a doc that holds math', () => {
  /** A fetch that never answers, counting how often it was started. */
  function countingFetch(): { calls: number } {
    const seen = { calls: 0 };
    setKatexForTest(null, () => {
      seen.calls++;
      return new Promise(() => {});
    });
    return seen;
  }

  it('starts no fetch when the doc has no equation', () => {
    const seen = countingFetch();
    mount('No equations, and it costs $5 and $10.\n\n```\n$$\n```\n');
    expect(seen.calls).toBe(0);
  });

  it('starts one fetch for a doc with several, and shows the TeX meanwhile', () => {
    const seen = countingFetch();
    mount(DOC);
    expect(seen.calls).toBe(1);
    expect(document.querySelector('.cw-math.cw-math-pending')?.textContent).toBe('x_e');
    expect(document.querySelector('.cm-math-display.cw-math-pending')?.textContent).toBe(
      '\\frac{a}{b}',
    );
  });

  it('draws what was waiting once KaTeX arrives', async () => {
    let arrive: (api: KatexApi) => void = () => {};
    setKatexForTest(null, () => new Promise((r) => (arrive = r)));
    mount(DOC);
    arrive(FAKE);
    await expect.poll(() => widgets()[0]?.querySelector('.katex')?.textContent).toBe('x_e');
    expect(document.querySelector('.cw-math-pending')).toBeNull();
  });
});

describe('markdown parsed in the client keeps equations equations', () => {
  // The redline renders every block of a diff through tiptap-markdown, and
  // the doc editor parses pasted markdown with it.
  function parsed(md: string) {
    setKatexForTest(FAKE);
    const host = document.createElement('div');
    const editor = new Editor({
      element: host,
      extensions: [
        StarterKit.configure({ codeBlock: false }),
        MermaidCodeBlock,
        MathInline,
        Markdown,
      ],
      content: md,
    });
    open.push(() => editor.destroy());
    return editor.getJSON() as JSONContent;
  }

  it('reads `$a*b$ and $c*d$` as two equations, not an italic', () => {
    const json = JSON.stringify(parsed('$a*b$ and $c*d$'));
    expect(json).not.toContain('"italic"');
    const para = parsed('$a*b$ and $c*d$').content?.[0];
    expect(para?.content?.map((n) => [n.text, n.marks?.map((m) => m.type)])).toEqual([
      ['a*b', ['math']],
      [' and ', undefined],
      ['c*d', ['math']],
    ]);
  });

  it('keeps a price as text', () => {
    const para = parsed('It costs $5 and $10.').content?.[0];
    expect(para?.content).toEqual([{ type: 'text', text: 'It costs $5 and $10.' }]);
  });

  it('reads a `$$` block as the display-equation code block, blank line kept', () => {
    const block = parsed('Before\n\n$$\na\n\nb\n$$\n').content?.[1];
    expect(block?.type).toBe('codeBlock');
    expect(block?.attrs?.language).toBe(prose.MATH_DISPLAY_LANGUAGE);
    expect(block?.content?.[0]?.text).toBe('$$\na\n\nb\n$$');
  });
});
