import { prose } from '@claude-workspaces/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { REDRAW_MS } from '../src/mdx-flow-block.ts';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * Editing a chart's tag in place: Edit opens the source for typing in that
 * block only, the chart redraws once the typing pauses, a source that does
 * not draw keeps the last chart that did, and the text reaches another open
 * copy of the doc. Fixtures are fictional.
 */

const POST = `Ridership climbed all year.

<Chart
  title="Riverbend riders"
  data={[
    { x: 1, y: 120 },
    { x: 2, y: 135 },
    { x: 3, y: 128 },
  ]}
/>

<Callout type="note">
  The last sailing moved to 21:30.
</Callout>
`;

const open: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function seed(md = POST): Y.Doc {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md, { mdx: true }));
  return ydoc;
}

function mount(ydoc: Y.Doc, editable = true): { handle: EditorHandle; root: HTMLElement } {
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc), editable });
  open.push(() => handle.destroy());
  return { handle, root: parent };
}

const md = (ydoc: Y.Doc) => prose.serializeFragmentToMarkdown(prose.getProseFragment(ydoc));
const chartOf = (root: HTMLElement) =>
  root.querySelector<HTMLElement>('.mdx-block.has-chart') as HTMLElement;
const titleOf = (root: HTMLElement) => chartOf(root).querySelector('.mdx-title')?.textContent;

/** The document position of `text`'s first character. */
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

function type(handle: EditorHandle, at: number, text: string, to = at): void {
  handle.editor.chain().setTextSelection({ from: at, to }).insertContent(text).run();
}

describe("editing a chart's tag", () => {
  it('offers Edit on a chart and not on other components, and swaps it to Done', () => {
    const { root } = mount(seed());
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('.mdx-block.has-chart .mdx-edit')];
    expect(buttons).toHaveLength(1);
    const edit = buttons[0] as HTMLButtonElement;
    expect([edit.textContent, edit.getAttribute('aria-pressed')]).toEqual(['Edit', 'false']);
    edit.click();
    expect(chartOf(root).classList.contains('is-editing')).toBe(true);
    expect([edit.textContent, edit.getAttribute('aria-pressed')]).toEqual(['Done', 'true']);
    edit.click();
    expect(chartOf(root).classList.contains('is-editing')).toBe(false);
    expect(edit.textContent).toBe('Edit');
  });

  it('takes typing in the open block only, and refuses it in every other block', () => {
    const ydoc = seed();
    const { handle, root } = mount(ydoc);
    chartOf(root).querySelector<HTMLElement>('.mdx-edit')?.click();
    type(handle, posOf(handle, 'Riverbend riders'), 'North ');
    expect(md(ydoc)).toContain('title="North Riverbend riders"');

    const before = md(ydoc);
    type(handle, posOf(handle, 'The last sailing'), 'X');
    expect(md(ydoc)).toBe(before);
    // Nor may an edit run out of the open block into the prose beside it.
    type(handle, posOf(handle, 'climbed'), '', posOf(handle, 'North'));
    expect(md(ydoc)).toBe(before);

    // Nor may it split the open block into two.
    handle.editor.chain().setTextSelection(posOf(handle, 'North')).splitBlock().run();
    expect(md(ydoc)).toBe(before);

    // Done closes it again.
    chartOf(root).querySelector<HTMLElement>('.mdx-edit')?.click();
    type(handle, posOf(handle, 'North'), 'X');
    expect(md(ydoc)).toBe(before);
  });

  it('redraws once the typing pauses', () => {
    const { handle, root } = mount(seed());
    chartOf(root).querySelector<HTMLElement>('.mdx-edit')?.click();
    const at = posOf(handle, 'Riverbend riders');
    type(handle, at, 'S');
    vi.advanceTimersByTime(REDRAW_MS - 50);
    type(handle, at + 1, 'outh ');
    vi.advanceTimersByTime(REDRAW_MS - 50);
    expect(titleOf(root)).toBe('Riverbend riders');
    vi.advanceTimersByTime(50);
    expect(titleOf(root)).toBe('South Riverbend riders');
  });

  it('keeps the last chart that drew and names the fault when the tag breaks', () => {
    const ydoc = seed();
    const { handle, root } = mount(ydoc);
    chartOf(root).querySelector<HTMLElement>('.mdx-edit')?.click();
    const line = () => chartOf(root).querySelector('svg.mdx-chart polyline');
    const drawn = line();
    expect(drawn).not.toBeNull();
    const error = () => chartOf(root).querySelector<HTMLElement>('.mdx-edit-error');

    // A string left open: the tag no longer parses.
    type(handle, posOf(handle, 'Riverbend riders"'), 'x"y');
    vi.advanceTimersByTime(REDRAW_MS);
    expect(line()).toBe(drawn);
    expect(titleOf(root)).toBe('Riverbend riders');
    expect(error()?.hidden).toBe(false);
    expect(error()?.textContent).toContain('<Chart> is not closed');
    expect(md(ydoc)).toContain('title="x"yRiverbend riders"');

    // Fixed, the chart redraws and the fault goes.
    type(handle, posOf(handle, '"yRiverbend'), '', posOf(handle, 'Riverbend riders'));
    vi.advanceTimersByTime(REDRAW_MS);
    expect(titleOf(root)).toBe('xRiverbend riders');
    expect(error()?.hidden).toBe(true);
  });

  it('keeps the chart when the data stops being literal', () => {
    const { handle, root } = mount(seed());
    chartOf(root).querySelector<HTMLElement>('.mdx-edit')?.click();
    const at = posOf(handle, '{ x: 1, y: 120 }') + '{ x: 1, y: '.length;
    type(handle, at, 'n', at + 3);
    vi.advanceTimersByTime(REDRAW_MS);
    expect(chartOf(root).querySelector('svg.mdx-chart polyline')).not.toBeNull();
    expect(chartOf(root).querySelector('.mdx-edit-error')?.textContent).toContain(
      'no longer reads as a chart',
    );
  });

  it('offers Edit on a chart tag that was left broken, and draws it once fixed', () => {
    const ydoc = seed(POST.replace('{ x: 1, y: 120 }', '{ x: 1, y: n }'));
    const { handle, root } = mount(ydoc);
    expect(chartOf(root).querySelector('svg.mdx-chart')).toBeNull();
    chartOf(root).querySelector<HTMLElement>('.mdx-edit')?.click();
    const at = posOf(handle, 'y: n }') + 'y: '.length;
    type(handle, at, '120', at + 1);
    vi.advanceTimersByTime(REDRAW_MS);
    expect(chartOf(root).querySelector('svg.mdx-chart polyline')).not.toBeNull();
  });

  it('shows the edit and the redrawn chart on another open copy of the doc', () => {
    const a = seed();
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    a.on(
      'update',
      (u: Uint8Array, origin: unknown) => origin !== 'peer' && Y.applyUpdate(b, u, 'peer'),
    );
    b.on(
      'update',
      (u: Uint8Array, origin: unknown) => origin !== 'peer' && Y.applyUpdate(a, u, 'peer'),
    );
    const mine = mount(a);
    const theirs = mount(b);
    chartOf(mine.root).querySelector<HTMLElement>('.mdx-edit')?.click();
    type(mine.handle, posOf(mine.handle, 'Riverbend riders'), 'West ');
    // The other page's source and chart change with no timer run at all.
    expect(chartOf(theirs.root).querySelector('.mdx-source')?.textContent).toContain(
      'title="West Riverbend riders"',
    );
    expect(titleOf(theirs.root)).toBe('West Riverbend riders');
    expect(chartOf(theirs.root).classList.contains('is-editing')).toBe(false);
  });

  it('offers no Edit to a reader who cannot write', () => {
    open.push(installSheets('styles.css', 'doc.css'));
    const { root } = mount(seed(), false);
    const edit = chartOf(root).querySelector('.mdx-edit') as Element;
    expect(styleOf(edit).display).toBe('none');
    edit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(chartOf(root).classList.contains('is-editing')).toBe(false);
  });

  for (const vp of [IPAD, PHONE]) {
    it(`gives Edit and Done one 44px-tall target at ${vp.width}px`, () => {
      setViewport(vp);
      open.push(installSheets('styles.css', 'doc.css'));
      const { root } = mount(seed());
      const edit = chartOf(root).querySelector('.mdx-edit') as HTMLElement;
      const box = () => {
        const st = styleOf(edit);
        return [st.display, st.position, st.top, st.right, st.minWidth, st.minHeight];
      };
      const closed = box();
      expect(closed).toEqual(['block', 'absolute', '0px', '0px', '64px', '44px']);
      edit.click();
      expect(box()).toEqual(closed);
    });
  }
});
