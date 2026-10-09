import { prose } from '@claude-workspaces/core';
import { Slice } from '@tiptap/pm/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { wireFormatBar } from '../src/doc/editor-toolbar.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * Pasting, dropping or picking an image stores the file beside the doc and
 * writes `![](images/…)` into the doc, which is what reaches the `.md`.
 */
const STORED = 'images/harborlight-chart-1a2b3c4d.png';
const open: Array<{ handle: EditorHandle; parent: HTMLElement }> = [];
let calls: Array<{ url: string; init: RequestInit }> = [];
let answer: () => Response;

beforeEach(() => {
  window.history.replaceState(null, '', '/workspaces/ws-1/docs/harborlight');
  document.body.innerHTML = '<div id="toast" class="hidden"></div>';
  calls = [];
  answer = () => new Response(JSON.stringify({ src: STORED }), { status: 201 });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const o of open.splice(0)) {
    o.handle.destroy();
    o.parent.remove();
  }
});

function mount(imageDocId?: string) {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  fragment.push(prose.parseMarkdownBlocks('Riverbend\n'));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc), imageDocId });
  open.push({ handle, parent });
  return { fragment, handle, parent };
}

const png = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'Harborlight Chart.png', {
    type: 'image/png',
  });

/** Run the editor's own paste handlers, as a browser paste event would. */
function paste(handle: EditorHandle, files: File[]): boolean {
  const view = handle.editor.view;
  const clipboardData = { files, getData: () => '', types: ['Files'] };
  const event = { clipboardData, preventDefault() {} } as unknown as ClipboardEvent;
  return view.someProp('handlePaste', (f) => f(view, event, Slice.empty)) ?? false;
}

describe('pasting an image file', () => {
  it('stores it beside the doc and writes the image line into the doc', async () => {
    const { fragment, handle, parent } = mount('harborlight');
    expect(paste(handle, [png()])).toBe(true);
    await vi.waitFor(() => expect(parent.querySelector('img')).not.toBeNull());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      '/workspaces/ws-1/docs/harborlight/assets?name=Harborlight%20Chart.png',
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(prose.serializeFragmentToMarkdown(fragment)).toContain(`![](${STORED})`);
    // And it displays from the doc's folder, as PR 1's relative images do.
    expect(parent.querySelector('img')?.getAttribute('src')).toBe(
      `/workspaces/ws-1/docs/harborlight/assets/${STORED}`,
    );
  });

  it('inserts nothing and says why when the server refuses the file', async () => {
    answer = () => new Response(JSON.stringify({ error: 'too big' }), { status: 413 });
    const { fragment, handle } = mount('harborlight');
    paste(handle, [png()]);
    await vi.waitFor(() =>
      expect(document.getElementById('toast')?.textContent).toContain('too big'),
    );
    expect(prose.serializeFragmentToMarkdown(fragment)).not.toContain('![');
  });

  it('leaves a paste with no image file to the editor', () => {
    const { handle } = mount('harborlight');
    const text = new File(['x'], 'notes.txt', { type: 'text/plain' });
    expect(paste(handle, [text])).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('takes no image on a surface with no doc to store beside', () => {
    const { handle } = mount(undefined);
    expect(paste(handle, [png()])).toBe(false);
    expect(handle.attachImage).toBeUndefined();
  });
});

describe('Attach image', () => {
  it('stores the picked file and writes the line, as a paste does', async () => {
    const { fragment, handle } = mount('harborlight');
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      Object.defineProperty(this, 'files', { value: [png()] });
      this.dispatchEvent(new Event('change'));
    });
    handle.attachImage?.();
    await vi.waitFor(() =>
      expect(prose.serializeFragmentToMarkdown(fragment)).toContain(`![](${STORED})`),
    );
    expect(click).toHaveBeenCalledOnce();
  });
});

describe('the Aa bar', () => {
  const bar = () => {
    const el = document.createElement('div');
    el.id = 'format-bar';
    el.innerHTML = '<button type="button" data-cmd="image">🖼</button>';
    document.body.appendChild(el);
    return el.querySelector('button') as HTMLButtonElement;
  };

  it('runs Attach image from its button', () => {
    const { handle } = mount('harborlight');
    const attach = vi.fn();
    const btn = bar();
    wireFormatBar({ ...handle, attachImage: attach }, new MountScope());
    expect(btn.hidden).toBe(false);
    btn.click();
    expect(attach).toHaveBeenCalledOnce();
  });

  it('hides the button where there is no doc to store an image beside', () => {
    const { handle } = mount(undefined);
    const btn = bar();
    wireFormatBar(handle, new MountScope());
    expect(btn.hidden).toBe(true);
  });
});
